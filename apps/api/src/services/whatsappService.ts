import type { IntentEngine, DateLocationExtractionOrchestrator } from '@ai-concierge/ai';
import type { VehicleDeterminationOrchestrator, MissingInfoOrchestrator } from '@ai-concierge/ai';
import {
  findIdempotencyKey,
  findLatestConversationForCustomer,
  updateConversationStage,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import { messageContentSchema, type TenantId } from '@ai-concierge/domain';
import type { Queue } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { submitEnquiry } from './enquiryService.js';
import { advanceWhatsAppConversation } from './whatsappConversationState.js';
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
 * Runs one inbound WhatsApp text message through the Steps 1-4 pipeline
 * (submitEnquiry -> the conversation-stage machine -> Steps 2-4 as needed),
 * then replies with whatever that decided. Still a channel adapter, not new
 * business logic: Steps 2-4 themselves are untouched, called exactly as
 * before via `whatsappConversationState.ts`.
 *
 * Every inbound message resumes the customer's most recent WhatsApp
 * conversation (found by tenant + channel + the sender's WhatsApp id)
 * instead of always starting a fresh, context-free one — the fix for a
 * short reply like "Yes" otherwise being indistinguishable from a new
 * greeting. `stage` on that conversation is what makes a reply like "Yes"
 * interpretable at all: see `whatsappConversationState.ts` for why.
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
    const existingConversation = await findLatestConversationForCustomer(
      deps.prisma,
      input.tenantId,
      'WHATSAPP',
      message.from,
    );

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
        conversationId: existingConversation?.id,
      },
    );

    const { replyText, nextStage, nextCycleStartedAt } = await advanceWhatsAppConversation(
      {
        prisma: deps.prisma,
        dateLocationOrchestrator: deps.dateLocationOrchestrator,
        vehicleOrchestrator: deps.vehicleOrchestrator,
        missingInfoOrchestrator: deps.missingInfoOrchestrator,
      },
      {
        tenantId: input.tenantId,
        requestId: input.requestId,
        conversationId: enquiry.conversationId,
        stage: existingConversation?.stage ?? 'NEW',
        cycleStartedAt: existingConversation?.cycleStartedAt ?? new Date(),
        intent: enquiry.intent,
        messageText: textResult.data,
      },
    );

    // Send before persisting the new stage: if the send fails, the stage
    // must stay exactly what it was, so the customer's next message is
    // still interpreted against the question they actually received (the
    // outer catch below sends a generic fallback for this attempt).
    await deps.whatsappClient.sendTextMessage(message.from, replyText);

    await deps.prisma.$transaction(async (tx) => {
      const result = await updateConversationStage(
        tx,
        input.tenantId,
        enquiry.conversationId,
        nextStage,
        nextCycleStartedAt,
      );
      if (result.count > 0) {
        const auditWriter = new PrismaAuditWriter(tx);
        await auditWriter.record({
          tenantId: input.tenantId,
          actor: 'system:whatsapp-conversation-stage',
          action: 'conversation.stage_advanced',
          entityType: 'Conversation',
          entityId: enquiry.conversationId,
          after: { stage: nextStage },
          requestId: input.requestId,
        });
      }
    });
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
