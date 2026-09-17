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
