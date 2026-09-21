import { createHash } from 'node:crypto';
import { classifyShortReply, ShortReplyIntent, type IntentEngine } from '@ai-concierge/ai';
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
import {
  AppError,
  BOOKING_REQUIRED_FIELDS,
  IntentStatus,
  IntentType,
  type IntentResult,
  type TenantId,
} from '@ai-concierge/domain';
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
 * A bare "Yes"/"Sure"/... carries no BOOKING_REQUEST keyword on its own, and
 * joining it into the accumulated transcript doesn't create one either if
 * nothing earlier in the conversation did — so a customer confirming a
 * booking question with a plain "Yes" would otherwise classify exactly like
 * their first, unrecognized message did, and Step 4 would repeat the same
 * generic non-booking reply forever instead of progressing (the reported
 * bug: "Hiii" -> generic reply -> "Yes" -> the *same* generic reply again).
 *
 * Deliberately scoped to `UNKNOWN` only, not "anything other than
 * BOOKING_REQUEST": if the transcript already recognized a *different*
 * meaningful intent (COMPLAINT, SUPPORT_REQUEST, ...), a later "Yes" is
 * answering whatever question *that* raised, not confirming a booking — the
 * ambiguity this correction resolves only exists when Step 1 found no
 * signal at all.
 */
function isBookingConfirmationReply(recognized: IntentResult, newMessage: string): boolean {
  return (
    recognized.intentType === IntentType.UNKNOWN &&
    classifyShortReply(newMessage) === ShortReplyIntent.AFFIRMATIVE
  );
}

/**
 * Deterministically corrects a short affirmative reply's intent to
 * BOOKING_REQUEST — not a new AI guess, just recognizing that "Yes" answers
 * whatever question this (booking-focused) system just asked. Recomputes
 * `missingFields`/`status`/`clarificationPrompt` the same way
 * `RuleBasedIntentEngine` itself would for a BOOKING_REQUEST classification
 * (see `intent-engine.ts`), so the persisted IntentRecord stays internally
 * consistent instead of pairing the new intentType with the old UNKNOWN
 * classification's (always-empty) missingFields. `engine` is tagged
 * distinctly from `rule-based-v1` so the audit trail never implies the
 * keyword engine itself matched a booking term it didn't.
 */
function confirmBookingIntent(recognized: IntentResult): IntentResult {
  const missingFields = BOOKING_REQUIRED_FIELDS.filter(
    (field) => recognized.entities[field] === undefined,
  );
  const needsClarification = missingFields.length > 0;

  return {
    ...recognized,
    intentType: IntentType.BOOKING_REQUEST,
    status: needsClarification ? IntentStatus.NEEDS_CLARIFICATION : IntentStatus.RECOGNIZED,
    missingFields,
    ...(needsClarification
      ? {
          clarificationPrompt: `Could you share the following to proceed: ${missingFields.join(', ')}?`,
        }
      : {}),
    modelMetadata: { ...recognized.modelMetadata, engine: 'short-reply-confirmation-v1' },
  };
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
 * A bare affirmative reply ("Yes") is corrected the same way even when nothing
 * in the transcript ever used a booking keyword — see
 * `isBookingConfirmationReply`. Steps 2-3 pick up the same accumulated
 * transcript independently (dateLocationService/vehicleService); this
 * function only owns Step 1 and the message-append, mirroring
 * `submitEnquiry`'s shape for a conversation that already exists. No
 * `postEnquiryQueue` job here — that background processing already ran (and
 * is marked) for this conversation's first message; `markConversationProcessed`'s
 * idempotent no-op would otherwise just log a warning on every follow-up
 * turn for nothing.
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
    const recognized = deps.intentEngine.recognize(transcript);
    const intent = isBookingConfirmationReply(recognized, input.message)
      ? confirmBookingIntent(recognized)
      : recognized;

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
