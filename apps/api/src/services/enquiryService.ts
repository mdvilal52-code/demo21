import { createHash } from 'node:crypto';
import type { IntentEngine } from '@ai-concierge/ai';
import {
  appendMessageToConversation,
  createConversationWithMessage,
  createIntentRecord,
  findIdempotencyKey,
  findMessagesForConversation,
  PrismaAuditWriter,
  saveIdempotencyKey,
  type Channel,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, type TenantId } from '@ai-concierge/domain';
import type { CreateEnquiryResponse } from '@ai-concierge/contracts';
import type { Queue } from 'bullmq';
import { buildAccumulatedTranscript } from '../lib/conversationTranscript.js';

export interface EnquiryServiceDeps {
  prisma: PrismaClient;
  intentEngine: IntentEngine;
  postEnquiryQueue: Queue;
}

export interface ContinueEnquiryDeps {
  prisma: PrismaClient;
  intentEngine: IntentEngine;
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
    const { conversation, message } = await createConversationWithMessage(tx, {
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

export interface ContinueEnquiryInput {
  tenantId: TenantId;
  conversationId: string;
  channel: Channel;
  message: string;
  requestId: string;
  idempotencyKey?: string;
}

function hashContinueRequest(input: ContinueEnquiryInput): string {
  return createHash('sha256')
    .update(JSON.stringify({ conversationId: input.conversationId, message: input.message }))
    .digest('hex');
}

/**
 * Appends a new message to a conversation that's already open (see
 * `findOpenConversationForCustomer`) instead of starting a fresh one, and
 * re-runs Step 1 intent recognition against the conversation's accumulated
 * transcript (every message so far, oldest first, this one included) rather
 * than this message alone — so a follow-up that's just dates, or just a
 * location, still resolves against the booking intent an earlier message in
 * the same conversation already established, instead of independently
 * looking like a non-booking message and falling back to a generic reply.
 * Steps 2-3 pick up the same accumulated transcript independently
 * (dateLocationService/vehicleService); this function only owns Step 1 and
 * the message-append, mirroring `submitEnquiry`'s shape for a conversation
 * that already exists. No `postEnquiryQueue` job here — that background
 * processing already ran (and is marked) for this conversation's first
 * message; `markConversationProcessed`'s idempotent no-op would otherwise
 * just log a warning on every follow-up turn for nothing.
 */
export async function continueEnquiry(
  deps: ContinueEnquiryDeps,
  input: ContinueEnquiryInput,
): Promise<CreateEnquiryResponse> {
  const requestHash = hashContinueRequest(input);

  if (input.idempotencyKey) {
    const existing = await findIdempotencyKey(deps.prisma, input.idempotencyKey);
    if (existing) {
      return existing.responseBody as CreateEnquiryResponse;
    }
  }

  return deps.prisma.$transaction(async (tx) => {
    const priorMessages = await findMessagesForConversation(
      tx,
      input.tenantId,
      input.conversationId,
    );
    const message = await appendMessageToConversation(
      tx,
      input.tenantId,
      input.conversationId,
      input.message,
    );
    if (!message) {
      throw new AppError('NOT_FOUND', 'Conversation not found');
    }

    const transcript = buildAccumulatedTranscript([...priorMessages, message]);
    const intent = deps.intentEngine.recognize(transcript);

    await createIntentRecord(tx, {
      tenantId: input.tenantId,
      messageId: message.id,
      intentResult: intent,
    });

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: input.tenantId,
      actor: `channel:${input.channel.toLowerCase()}`,
      action: 'enquiry.continued',
      entityType: 'Conversation',
      entityId: input.conversationId,
      after: { intentType: intent.intentType, status: intent.status },
      requestId: input.requestId,
    });

    const result: CreateEnquiryResponse = {
      conversationId: input.conversationId,
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
}
