import { createHash } from 'node:crypto';
import type { IntentEngine } from '@ai-concierge/ai';
import {
  appendMessageToConversation,
  createConversationWithMessage,
  createIntentRecord,
  findIdempotencyKey,
  findLatestMessageForConversation,
  findLatestMissingInfoCheckForMessage,
  findMostRecentConversationForCustomer,
  PrismaAuditWriter,
  saveIdempotencyKey,
  type Channel,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, MISSING_INFO_TIMEOUT_HOURS, MissingInfoStatus, type TenantId } from '@ai-concierge/domain';
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

const REOPEN_WINDOW_MS = MISSING_INFO_TIMEOUT_HOURS * 60 * 60 * 1000;

/**
 * COMPLETE means Step 4 already got everything it needed — the next message
 * from this customer is a new request (e.g. a second booking), not a
 * continuation. EXPIRED means the customer missed the reopen window and was
 * already told to start over (see `buildWhatsAppReplyText`'s EXPIRED copy) —
 * reopening it after telling them otherwise would be confusing. Anything
 * else (still NEEDS_INFO, NOT_APPLICABLE, or no check yet) is a genuine
 * in-progress conversation and should be continued, not fragmented.
 */
function isReopenableStatus(status: string | undefined): boolean {
  return status !== MissingInfoStatus.COMPLETE && status !== MissingInfoStatus.EXPIRED;
}

/**
 * Finds the customer's most recent conversation on this channel, if it's
 * still an open, in-progress request within the same 24h window Step 4 uses
 * for its own expiry — so a follow-up message ("actually, make it 5 days")
 * continues the existing conversation Steps 2-4 already built context for,
 * instead of starting from a blank slate every single message.
 */
async function findReopenableConversationId(
  deps: EnquiryServiceDeps,
  input: SubmitEnquiryInput,
): Promise<string | null> {
  const candidate = await findMostRecentConversationForCustomer(
    deps.prisma,
    input.tenantId,
    input.channel,
    input.customerRef,
  );
  if (!candidate || Date.now() - candidate.createdAt.getTime() >= REOPEN_WINDOW_MS) {
    return null;
  }

  const latestMessage = await findLatestMessageForConversation(
    deps.prisma,
    input.tenantId,
    candidate.id,
  );
  const latestCheck = latestMessage
    ? await findLatestMissingInfoCheckForMessage(deps.prisma, input.tenantId, latestMessage.id)
    : null;

  return isReopenableStatus(latestCheck?.status) ? candidate.id : null;
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
  const reopenConversationId = await findReopenableConversationId(deps, input);

  const response = await deps.prisma.$transaction(async (tx) => {
    const { conversation, message } = reopenConversationId
      ? await appendMessageToConversation(tx, input.tenantId, reopenConversationId, input.message)
      : await createConversationWithMessage(tx, {
          tenantId: input.tenantId,
          channel: input.channel,
          customerRef: input.customerRef,
          content: input.message,
        });

    await createIntentRecord(tx, {
      tenantId: input.tenantId,
      messageId: message.id,
      intentResult: intent,
    });

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: input.tenantId,
      actor: `channel:${input.channel.toLowerCase()}`,
      action: reopenConversationId ? 'enquiry.continued' : 'enquiry.received',
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
