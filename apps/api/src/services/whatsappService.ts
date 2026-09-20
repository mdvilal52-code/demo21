import type { IntentEngine, DateLocationExtractionOrchestrator } from '@ai-concierge/ai';
import type { VehicleDeterminationOrchestrator, MissingInfoOrchestrator } from '@ai-concierge/ai';
import { findIdempotencyKey, type PrismaClient } from '@ai-concierge/db';
import { messageContentSchema, type TenantId } from '@ai-concierge/domain';
import type { Queue } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { submitEnquiry } from './enquiryService.js';
import { extractDatesAndLocation } from './dateLocationService.js';
import { determineVehicle } from './vehicleService.js';
import { checkMissingInfo } from './missingInfoService.js';
import {
  buildWhatsAppReplyText,
  WHATSAPP_MESSAGE_TOO_LONG_REPLY,
  WHATSAPP_UNSUPPORTED_MESSAGE_TYPE_REPLY,
} from './whatsappReply.js';
import type { WhatsAppClient } from '../lib/whatsappClient.js';
import type { InboundWhatsAppMessage } from '../lib/whatsappWebhookPayload.js';

export interface WhatsAppServiceDeps {
  prisma: PrismaClient;
  intentEngine: IntentEngine;
  postEnquiryQueue: Queue;
  dateLocationOrchestrator: DateLocationExtractionOrchestrator;
  vehicleOrchestrator: VehicleDeterminationOrchestrator;
  missingInfoOrchestrator: MissingInfoOrchestrator;
  whatsappClient: WhatsAppClient;
  logger: FastifyBaseLogger;
}

export interface HandleInboundWhatsAppMessageInput {
  tenantId: TenantId;
  requestId: string;
  message: InboundWhatsAppMessage;
}

async function safeReply(deps: WhatsAppServiceDeps, to: string, body: string): Promise<void> {
  try {
    await deps.whatsappClient.sendTextMessage(to, body);
  } catch (error) {
    deps.logger.error({ err: error, to }, 'failed to send WhatsApp reply');
  }
}

/**
 * Runs one inbound WhatsApp text message through the exact same Steps 1-4
 * pipeline a REST client drives via four separate calls (submitEnquiry ->
 * extractDatesAndLocation -> determineVehicle -> checkMissingInfo), then
 * replies with whatever Step 4 decided. No new business logic: this is a
 * channel adapter over already-frozen, already-tested pipeline logic.
 *
 * Each inbound message starts a fresh conversation (matching submitEnquiry's
 * own contract exactly) — there's no cross-message thread memory yet. A
 * customer's follow-up reply to a clarification question is processed as an
 * independent new enquiry, not merged with what an earlier message resolved.
 * That conversational loop is explicitly later-phase scope (PHASE-4.md §13 /
 * MASTER-PLAN.md's Event/Workflow Engine), not a channel-adapter concern.
 */
export async function handleInboundWhatsAppMessage(
  deps: WhatsAppServiceDeps,
  input: HandleInboundWhatsAppMessageInput,
): Promise<void> {
  const { message } = input;

  const existing = await findIdempotencyKey(deps.prisma, message.id);
  if (existing) {
    deps.logger.info({ whatsappMessageId: message.id }, 'duplicate WhatsApp message, skipping');
    return;
  }

  if (message.type !== 'text' || message.text === null) {
    deps.logger.info(
      { whatsappMessageId: message.id, type: message.type },
      'unsupported WhatsApp message type',
    );
    await safeReply(deps, message.from, WHATSAPP_UNSUPPORTED_MESSAGE_TYPE_REPLY);
    return;
  }

  const textResult = messageContentSchema.safeParse(message.text);
  if (!textResult.success) {
    deps.logger.warn(
      { whatsappMessageId: message.id },
      'WhatsApp message failed content validation',
    );
    await safeReply(deps, message.from, WHATSAPP_MESSAGE_TOO_LONG_REPLY);
    return;
  }

  try {
    const enquiry = await submitEnquiry(
      {
        prisma: deps.prisma,
        intentEngine: deps.intentEngine,
        postEnquiryQueue: deps.postEnquiryQueue,
      },
      {
        tenantId: input.tenantId,
        channel: 'WHATSAPP',
        customerRef: message.from,
        message: textResult.data,
        requestId: input.requestId,
        idempotencyKey: message.id,
      },
    );

    await extractDatesAndLocation(
      { prisma: deps.prisma, orchestrator: deps.dateLocationOrchestrator },
      {
        tenantId: input.tenantId,
        conversationId: enquiry.conversationId,
        requestId: input.requestId,
      },
    );

    await determineVehicle(
      { prisma: deps.prisma, orchestrator: deps.vehicleOrchestrator },
      {
        tenantId: input.tenantId,
        conversationId: enquiry.conversationId,
        requestId: input.requestId,
      },
    );

    const missingInfo = await checkMissingInfo(
      { prisma: deps.prisma, orchestrator: deps.missingInfoOrchestrator },
      {
        tenantId: input.tenantId,
        conversationId: enquiry.conversationId,
        requestId: input.requestId,
      },
    );

    await deps.whatsappClient.sendTextMessage(
      message.from,
      buildWhatsAppReplyText(missingInfo.missingInfo),
    );
  } catch (error) {
    deps.logger.error(
      { err: error, whatsappMessageId: message.id },
      'failed to process inbound WhatsApp message',
    );
    await safeReply(
      deps,
      message.from,
      'Sorry, something went wrong on our end. Please try again in a moment.',
    );
  }
}
