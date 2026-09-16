import type { Prisma, PrismaClient } from '@prisma/client';
import {
  normalizedLocationSchema,
  type DateLocationExtractionResult,
  type NormalizedLocation,
  type TenantId,
} from '@ai-concierge/domain';

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

export interface DateLocationForConversation {
  pickupLocation: NormalizedLocation | null;
  dropoffLocation: NormalizedLocation | null;
}

/**
 * Step 4 needs Step 2's locations regardless of which message they were
 * extracted against (a later Step 4 turn's message never has its own
 * DateLocationExtraction row) — re-validated via Zod before it leaves this
 * package, same as the other steps' reads.
 */
export async function findLatestDateLocationExtractionForConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
): Promise<DateLocationForConversation | null> {
  const row = await db.dateLocationExtraction.findFirst({
    where: { tenantId, message: { conversationId } },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  return {
    pickupLocation: row.pickupLocation ? normalizedLocationSchema.parse(row.pickupLocation) : null,
    dropoffLocation: row.dropoffLocation
      ? normalizedLocationSchema.parse(row.dropoffLocation)
      : null,
  };
}
