import type { Prisma, PrismaClient } from '@prisma/client';
import type { MissingInfoResult, TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export interface CreateMissingInfoCheckInput {
  tenantId: TenantId;
  messageId: string;
  result: MissingInfoResult;
}

export async function createMissingInfoCheck(db: Executor, input: CreateMissingInfoCheckInput) {
  const { result } = input;
  return db.missingInfoCheck.create({
    data: {
      tenantId: input.tenantId,
      messageId: input.messageId,
      status: result.status,
      collected: result.collected as unknown as Prisma.InputJsonValue,
      missingFields: result.missingFields as unknown as Prisma.InputJsonValue,
      clarificationPrompt: result.clarificationPrompt,
      expiresAt: new Date(result.expiresAt),
      flags: result.flags,
      modelMetadata: result.modelMetadata,
    },
  });
}

/** Tenant-scoped read — same isolation convention as the other repositories. */
export async function findLatestMissingInfoCheckForMessage(
  db: Executor,
  tenantId: TenantId,
  messageId: string,
) {
  return db.missingInfoCheck.findFirst({
    where: { tenantId, messageId },
    orderBy: { createdAt: 'desc' },
  });
}
