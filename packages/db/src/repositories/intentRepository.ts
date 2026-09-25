import type { Prisma, PrismaClient } from '@prisma/client';
import type { IntentResult, TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export interface CreateIntentRecordInput {
  tenantId: TenantId;
  messageId: string;
  intentResult: IntentResult;
}

export async function createIntentRecord(db: Executor, input: CreateIntentRecordInput) {
  const { intentResult } = input;
  return db.intentRecord.create({
    data: {
      tenantId: input.tenantId,
      messageId: input.messageId,
      intentType: intentResult.intentType,
      status: intentResult.status,
      confidence: intentResult.confidence,
      entities: intentResult.entities,
      missingFields: intentResult.missingFields,
      clarificationPrompt: intentResult.clarificationPrompt ?? null,
      flags: intentResult.flags,
      modelMetadata: intentResult.modelMetadata,
    },
  });
}

/** Tenant-scoped read — same isolation convention as the other repositories. */
export async function findLatestIntentRecordForMessage(
  db: Executor,
  tenantId: TenantId,
  messageId: string,
) {
  return db.intentRecord.findFirst({
    where: { tenantId, messageId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Whether any message in this conversation was ever recognized as
 * BOOKING_REQUEST — the durable fallback signal for "this conversation is a
 * booking" once the accumulated transcript `continueEnquiry` re-scans each
 * turn has rolled the original booking-establishing message out of its
 * bounded window (see `buildAccumulatedTranscript`'s MAX_TRANSCRIPT_MESSAGES
 * / MAX_TRANSCRIPT_LENGTH). Existence-only (`findFirst`), so this stays cheap
 * even for a long-running conversation.
 */
export async function hasBookingRequestIntentInConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
): Promise<boolean> {
  const row = await db.intentRecord.findFirst({
    where: { tenantId, intentType: 'BOOKING_REQUEST', message: { conversationId } },
    select: { id: true },
  });
  return row !== null;
}
