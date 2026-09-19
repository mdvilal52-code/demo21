import { Prisma, type PrismaClient } from '@prisma/client';
import type { TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

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

export interface ClaimIdempotencyKeyInput {
  key: string;
  tenantId: TenantId;
  requestHash: string;
}

/**
 * Atomically claims a key *before* doing any work, so two concurrent
 * attempts (e.g. a webhook redelivered before the first attempt finished
 * processing) race on a single unique-constraint insert instead of on a
 * much later read-then-write — closing the gap `findIdempotencyKey` +
 * `saveIdempotencyKey` leaves open across a long-running operation. Returns
 * `true` if this call won the claim, `false` if another attempt already
 * holds it (any other error still propagates).
 */
export async function claimIdempotencyKey(
  db: Executor,
  input: ClaimIdempotencyKeyInput,
): Promise<boolean> {
  try {
    await db.idempotencyKey.create({
      data: {
        key: input.key,
        tenantId: input.tenantId,
        requestHash: input.requestHash,
        responseStatus: 0,
        responseBody: {},
      },
    });
    return true;
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return false;
    throw error;
  }
}

/** Fills in the real outcome on a key previously claimed with `claimIdempotencyKey`. */
export async function completeIdempotencyKey(
  db: Executor,
  key: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  await db.idempotencyKey.update({
    where: { key },
    data: { responseStatus, responseBody: responseBody as Prisma.InputJsonValue },
  });
}

/**
 * Releases a claim that never completed (the work after `claimIdempotencyKey`
 * threw) so a legitimate future retry can reprocess the message instead of
 * being stuck behind a claim that will never resolve.
 */
export async function releaseIdempotencyKeyClaim(db: Executor, key: string): Promise<void> {
  await db.idempotencyKey.deleteMany({ where: { key } });
}
