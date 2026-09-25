import type {
  AIProvider,
  IntentEngine,
  DateLocationExtractionOrchestrator,
} from '@ai-concierge/ai';
import type { VehicleDeterminationOrchestrator, MissingInfoOrchestrator } from '@ai-concierge/ai';
import { findIdempotencyKey, findMessagesForConversation, type PrismaClient } from '@ai-concierge/db';
import { messageContentSchema, type TenantId } from '@ai-concierge/domain';
import type { Queue } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { submitEnquiry } from './enquiryService.js';
import { extractDatesAndLocation } from './dateLocationService.js';
import { determineVehicle } from './vehicleService.js';
import { checkMissingInfo } from './missingInfoService.js';
import {
  generateConversationalReply,
  MAX_RECENT_TURNS_FOR_REPLY,
  type RecentTurn,
} from './conversationalReplyService.js';
import { joinTranscript, MAX_TRANSCRIPT_MESSAGES } from './conversationTranscript.js';
import {
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
  aiProvider: AIProvider;
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
 * extractDatesAndLocation -> determineVehicle -> checkMissingInfo). Business
 * facts are still 100% deterministic — Steps 1-4 never changed. What's new
 * (PHASE-06.md): `submitEnquiry` now reopens the customer's existing
 * in-progress conversation instead of always starting fresh, Steps 2-3 read
 * the accumulated transcript instead of only the latest message, and the
 * reply is phrased by `generateConversationalReply` — a real LLM call
 * grounded strictly in Step 4's verified result, falling back to the
 * original deterministic template whenever the provider isn't configured or
 * its output can't be trusted.
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

    // Fetched once and reused for Steps 2-3 and the reply generator below —
    // three separate re-fetches of the same conversation's message history
    // per inbound message was real, avoidable DB load.
    const conversationMessages = await findMessagesForConversation(
      deps.prisma,
      input.tenantId,
      enquiry.conversationId,
      { limit: MAX_TRANSCRIPT_MESSAGES },
    );
    const transcript = joinTranscript(conversationMessages);

    await extractDatesAndLocation(
      { prisma: deps.prisma, orchestrator: deps.dateLocationOrchestrator },
      {
        tenantId: input.tenantId,
        conversationId: enquiry.conversationId,
        requestId: input.requestId,
        precomputedTranscript: transcript,
      },
    );

    await determineVehicle(
      { prisma: deps.prisma, orchestrator: deps.vehicleOrchestrator },
      {
        tenantId: input.tenantId,
        conversationId: enquiry.conversationId,
        requestId: input.requestId,
        precomputedTranscript: transcript,
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

    const recentTurns: RecentTurn[] = conversationMessages
      .slice(-MAX_RECENT_TURNS_FOR_REPLY)
      .map((row) => ({ role: 'customer', content: row.content }));

    const reply = await generateConversationalReply(
      { aiProvider: deps.aiProvider, logger: deps.logger },
      { missingInfo: missingInfo.missingInfo, recentTurns },
    );

    await deps.whatsappClient.sendTextMessage(message.from, reply.text);
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
