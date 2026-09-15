import type { Prisma, PrismaClient } from '@prisma/client';
import type { TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export interface StoredIdempotentResponse {
  responseStatus: number;
  responseBody: unknown;
}

export async function findIdempotencyKey(
  db: Executor,
  key: string,
): Promise<StoredIdempotentResponse | null> {
  const row = await db.idempotencyKey.findUnique({ where: { key } });
  if (!row) return null;
  return { responseStatus: row.responseStatus, responseBody: row.responseBody };
}

export interface SaveIdempotencyKeyInput {
  key: string;
  tenantId: TenantId;
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
}

export async function saveIdempotencyKey(db: Executor, input: SaveIdempotencyKeyInput) {
  await db.idempotencyKey.create({
    data: {
      key: input.key,
      tenantId: input.tenantId,
      requestHash: input.requestHash,
      responseStatus: input.responseStatus,
      responseBody: input.responseBody as Prisma.InputJsonValue,
    },
  });
}
