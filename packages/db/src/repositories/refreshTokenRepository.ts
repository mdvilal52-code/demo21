import type { Prisma, PrismaClient } from '@prisma/client';
import type { TenantScopedClient } from '../tenantContext.js';

type Executor = PrismaClient | Prisma.TransactionClient | TenantScopedClient;

export interface CreateRefreshTokenInput {
  tenantId: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  ip?: string;
  userAgent?: string;
}

export async function createRefreshToken(db: Executor, input: CreateRefreshTokenInput) {
  return db.refreshToken.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

/**
 * Looked up by the opaque token's hash alone — same "the secret itself is
 * the authorization" pattern as `findIdempotencyKey` (idempotencyRepository.ts).
 * Deliberately NOT wrapped in `withTenantContext`: the caller doesn't know
 * which tenant a raw refresh token belongs to until this lookup tells them
 * (there is nothing else to key a tenant-scoped query on). The row found is
 * then used to derive `tenantId` for every subsequent tenant-scoped
 * operation (rotation, revocation). See docs/SECURITY-MODEL.md for the
 * follow-up this implies once the API's default DB connection is cut over
 * to the least-privilege `ai_concierge_api` role.
 */
export async function findRefreshTokenByHash(prisma: PrismaClient, tokenHash: string) {
  return prisma.refreshToken.findUnique({ where: { tokenHash } });
}

export async function revokeRefreshToken(
  db: Executor,
  id: string,
  replacedByTokenId: string | null = null,
) {
  await db.refreshToken.update({
    where: { id },
    data: { revokedAt: new Date(), replacedByTokenId },
  });
}

/** Stolen-token containment: revokes every token in a rotation chain, e.g. on reuse detection or an operator-triggered session revoke. */
export async function revokeRefreshTokenFamily(db: Executor, familyId: string) {
  await db.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** The distinct family ids a user currently has at least one non-revoked, non-expired token in — i.e. their active sessions, possibly across several devices. */
export async function findActiveSessionFamilyIds(db: Executor, userId: string): Promise<string[]> {
  const rows = await db.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { familyId: true },
    distinct: ['familyId'],
  });
  return rows.map((row) => row.familyId);
}

/** Account-lock containment: revokes every session a user holds, across every family/device. */
export async function revokeAllRefreshTokensForUser(db: Executor, userId: string) {
  await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
