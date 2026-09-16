import type { Prisma, PrismaClient } from '@prisma/client';
import {
  extractedEntitiesSchema,
  type ExtractedEntities,
  type IntentResult,
  type TenantId,
} from '@ai-concierge/domain';

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

/**
 * Step 4 needs Step 1's entities regardless of *which* message in the
 * conversation they were extracted against (Step 1 only ever runs once, on
 * the original enquiry — later turns never re-run it) — same tenant-scoped
 * read convention as the other steps, re-validated via Zod before it leaves
 * this package.
 */
export async function findLatestIntentRecordForConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
): Promise<{ entities: ExtractedEntities } | null> {
  const row = await db.intentRecord.findFirst({
    where: { tenantId, message: { conversationId } },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  return { entities: extractedEntitiesSchema.parse(row.entities) };
}
