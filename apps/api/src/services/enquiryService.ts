import { createHash } from 'node:crypto';
import type { IntentEngine } from '@ai-concierge/ai';
import {
  appendMessageToConversation,
  createConversationWithMessage,
  createIntentRecord,
  findIdempotencyKey,
  PrismaAuditWriter,
  saveIdempotencyKey,
  type Channel,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, type TenantId } from '@ai-concierge/domain';
import type { CreateEnquiryResponse } from '@ai-concierge/contracts';
import type { Queue } from 'bullmq';

export interface EnquiryServiceDeps {
  prisma: PrismaClient;
  intentEngine: IntentEngine;
  postEnquiryQueue: Queue;
}

export interface SubmitEnquiryInput {
  tenantId: TenantId;
  channel: Channel;
  customerRef: string;
  message: string;
  requestId: string;
  idempotencyKey?: string;
  /**
   * Appends to this already-existing conversation instead of creating a new
   * one — the multi-turn channel-adapter case (WhatsApp conversation
   * continuity). Omitted (the REST `/v1/enquiries` contract, unchanged):
   * behaves exactly as before, always creating a fresh conversation.
   */
  conversationId?: string;
}

function hashRequest(input: SubmitEnquiryInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        channel: input.channel,
        customerRef: input.customerRef,
        message: input.message,
      }),
    )
    .digest('hex');
}

export async function submitEnquiry(
  deps: EnquiryServiceDeps,
  input: SubmitEnquiryInput,
): Promise<CreateEnquiryResponse> {
  const requestHash = hashRequest(input);

  if (input.idempotencyKey) {
    const existing = await findIdempotencyKey(deps.prisma, input.idempotencyKey);
    if (existing) {
      return existing.responseBody as CreateEnquiryResponse;
    }
  }

  const intent = deps.intentEngine.recognize(input.message);

  const response = await deps.prisma.$transaction(async (tx) => {
    const created = input.conversationId
      ? await appendMessageToConversation(tx, {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          content: input.message,
        })
      : await createConversationWithMessage(tx, {
          tenantId: input.tenantId,
          channel: input.channel,
          customerRef: input.customerRef,
          content: input.message,
        });
    if (!created) {
      throw new AppError('NOT_FOUND', 'Conversation not found');
    }
    const { conversation, message } = created;

    await createIntentRecord(tx, {
      tenantId: input.tenantId,
      messageId: message.id,
      intentResult: intent,
    });

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: input.tenantId,
      actor: `channel:${input.channel.toLowerCase()}`,
      action: 'enquiry.received',
      entityType: 'Conversation',
      entityId: conversation.id,
      after: { intentType: intent.intentType, status: intent.status },
      requestId: input.requestId,
    });

    const result: CreateEnquiryResponse = {
      conversationId: conversation.id,
      messageId: message.id,
      intent,
    };

    if (input.idempotencyKey) {
      try {
        await saveIdempotencyKey(tx, {
          key: input.idempotencyKey,
          tenantId: input.tenantId,
          requestHash,
          responseStatus: 201,
          responseBody: result,
        });
      } catch {
        // A concurrent request already won the race to store this key; the
        // response we're about to return is still correct for this attempt.
      }
    }

    return result;
  });

  try {
    await deps.postEnquiryQueue.add(
      'process',
      {
        tenantId: input.tenantId,
        conversationId: response.conversationId,
        messageId: response.messageId,
        requestId: input.requestId,
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    );
  } catch (error) {
    // Best-effort in Phase 1: the conversation is already durably persisted.
    // A transactional outbox (Phase 3) removes this gap entirely.
    throw new AppError(
      'UPSTREAM_UNAVAILABLE',
      'Enquiry saved but background processing could not be queued',
      {
        cause: error,
        details: { conversationId: response.conversationId },
      },
    );
  }

  return response;
}
