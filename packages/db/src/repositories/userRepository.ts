import type { Prisma, PrismaClient } from '@prisma/client';
import type { UserRoleValue, UserStatusValue } from '@ai-concierge/domain';
import type { TenantScopedClient } from '../tenantContext.js';

type Executor = PrismaClient | Prisma.TransactionClient | TenantScopedClient;

/** Failed-login lockout: MASTER-PLAN.md §6's velocity anomaly rule made concrete for a single account. */
export const MAX_FAILED_LOGINS_BEFORE_LOCK = 5;
export const ACCOUNT_LOCK_DURATION_MS = 15 * 60 * 1000;

export interface CreateUserInput {
  tenantId: string;
  email: string;
  passwordHash: string;
  role: UserRoleValue;
}

export async function createUser(db: Executor, input: CreateUserInput) {
  return db.user.create({
    data: { ...input, email: input.email.toLowerCase() },
  });
}

/** Tenant-scoped by construction (`@@unique([tenantId, email])`) — the same email may exist under a different tenant without colliding. */
export async function findUserByEmail(db: Executor, tenantId: string, email: string) {
  return db.user.findUnique({
    where: { tenantId_email: { tenantId, email: email.toLowerCase() } },
  });
}

export async function findUserById(db: Executor, tenantId: string, id: string) {
  return db.user.findFirst({ where: { id, tenantId } });
}

export async function recordLoginFailure(db: Executor, userId: string) {
  const user = await db.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
  });
  if (user.failedLoginCount >= MAX_FAILED_LOGINS_BEFORE_LOCK) {
    await db.user.update({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() + ACCOUNT_LOCK_DURATION_MS) },
    });
    return true; // now locked
  }
  return false;
}

export async function resetLoginFailures(db: Executor, userId: string) {
  await db.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null },
  });
}

export async function setMfaSecret(db: Executor, userId: string, mfaSecretCiphertext: string) {
  await db.user.update({ where: { id: userId }, data: { mfaSecretCiphertext } });
}

export async function enableMfa(db: Executor, userId: string) {
  await db.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
}

export async function setUserStatus(db: Executor, userId: string, status: UserStatusValue) {
  await db.user.update({ where: { id: userId }, data: { status } });
}
