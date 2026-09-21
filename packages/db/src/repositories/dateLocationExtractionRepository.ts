import type { Prisma, PrismaClient } from '@prisma/client';
import type { DateLocationExtractionResult, TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export interface CreateDateLocationExtractionInput {
  tenantId: TenantId;
  messageId: string;
  result: DateLocationExtractionResult;
}

export async function createDateLocationExtraction(
  db: Executor,
  input: CreateDateLocationExtractionInput,
) {
  const { result } = input;
  return db.dateLocationExtraction.create({
    data: {
      tenantId: input.tenantId,
      messageId: input.messageId,
      pickupDate: result.pickupDate ? new Date(result.pickupDate) : null,
      returnDate: result.returnDate ? new Date(result.returnDate) : null,
      timezone: result.timezone,
      pickupLocation: (result.pickupLocation as Prisma.InputJsonValue | null) ?? undefined,
      dropoffLocation: (result.dropoffLocation as Prisma.InputJsonValue | null) ?? undefined,
      locationType: result.locationType,
      confidence: result.confidence,
      ambiguities: result.ambiguities as unknown as Prisma.InputJsonValue,
      validationErrors: result.validationErrors as unknown as Prisma.InputJsonValue,
      flags: result.flags,
      modelMetadata: result.modelMetadata,
    },
  });
}

/** Tenant-scoped read — same isolation convention as the other repositories. */
export async function findLatestDateLocationExtractionForMessage(
  db: Executor,
  tenantId: TenantId,
  messageId: string,
) {
  return db.dateLocationExtraction.findFirst({
    where: { tenantId, messageId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Every extraction run across every message in a conversation, oldest first
 * — lets a multi-turn channel (WhatsApp) carry a field resolved in an
 * earlier message (e.g. dates) forward into a later one that doesn't repeat
 * it, instead of only ever seeing the newest message's own run. Additive:
 * `findLatestDateLocationExtractionForMessage` above is unchanged and still
 * exactly what Step 2's own REST endpoint uses.
 *
 * `since`, when given, excludes rows from before the conversation's current
 * booking cycle (`Conversation.cycleStartedAt`) — without it, a finished
 * booking's dates would still look "already collected" for a later,
 * unrelated request reusing the same preserved conversation thread.
 */
export async function findDateLocationExtractionsForConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
  since?: Date,
) {
  return db.dateLocationExtraction.findMany({
    where: {
      tenantId,
      message: { conversationId },
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
}
