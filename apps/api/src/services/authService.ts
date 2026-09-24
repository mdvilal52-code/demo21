import {
  countRecentSecurityEvents,
  createRefreshToken,
  createUser as dbCreateUser,
  enableMfa,
  findActiveSessionFamilyIds,
  findRefreshTokenByHash,
  findUserByEmail,
  findUserById,
  PrismaAuditWriter,
  recordLoginFailure,
  recordSecurityEvent,
  resetLoginFailures,
  revokeAllRefreshTokensForUser,
  revokeRefreshToken,
  revokeRefreshTokenFamily,
  revokeRefreshTokenIfActive,
  setMfaSecret,
  setUserStatus,
  withTenantContext,
  type PrismaClient,
  type User,
} from '@ai-concierge/db';
import { decryptField, encryptField } from '@ai-concierge/security';
import {
  buildTotpEnrollmentUri,
  DUMMY_PASSWORD_HASH,
  generateTotpSecret,
  hashPassword,
  hashRefreshToken,
  issueRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyPassword,
  verifyTotpCode,
} from '@ai-concierge/security/authn';
import {
  AppError,
  SecurityEventType,
  SecuritySeverity,
  type AuthContext,
  type AuthenticatedUser,
  type TenantId,
  type UserRoleValue,
} from '@ai-concierge/domain';
import type { AuthTokenPair, MfaEnrollResponse } from '@ai-concierge/contracts';
import type { Redis } from 'ioredis';
import { revokeSessionFamily } from '../lib/sessionRevocation.js';

export interface AuthServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  jwtSigningSecret: string;
  mfaEncryptionKey: string;
  tokenIssuer: string;
}

function toAuthenticatedUser(user: User): AuthenticatedUser {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
    status: user.status,
    mfaEnabled: user.mfaEnabled,
  };
}

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/** A tenant-wide burst of failed logins (any account) beyond ordinary single-account lockout — a credential-stuffing/brute-force sweep signal. */
const LOGIN_VELOCITY_THRESHOLD = 20;
const LOGIN_VELOCITY_WINDOW_MS = 5 * 60 * 1000;

async function issueAccessToken(deps: AuthServiceDeps, user: User, familyId: string) {
  return signAccessToken(
    { userId: user.id, tenantId: user.tenantId, role: user.role, sessionFamilyId: familyId },
    deps.jwtSigningSecret,
  );
}

export interface CreateStaffUserInput {
  tenantId: TenantId;
  email: string;
  password: string;
  role: UserRoleValue;
}

/** Staff accounts are provisioned (seed script, or a future admin-only "invite user" endpoint), never self-registered — matches least-privilege ("who may create an ADMIN/SECURITY account" is not an open question). */
export async function createStaffUser(deps: AuthServiceDeps, input: CreateStaffUserInput) {
  const passwordHash = await hashPassword(input.password);
  return withTenantContext(deps.prisma, input.tenantId, (tx) =>
    dbCreateUser(tx, {
      tenantId: input.tenantId,
      email: input.email,
      passwordHash,
      role: input.role,
    }),
  );
}

export interface LoginInput extends RequestMeta {
  tenantId: TenantId;
  email: string;
  password: string;
  mfaCode?: string;
  requestId: string;
}

type LoginOutcome =
  | { ok: true; pair: AuthTokenPair }
  | { ok: false; code: 'UNAUTHORIZED' | 'FORBIDDEN'; message: string; mfaRequired?: true };

/**
 * A failed attempt still needs its `recordLoginFailure`/`recordSecurityEvent`
 * writes to survive — but `withTenantContext` wraps this in a
 * `prisma.$transaction`, and throwing from inside a Prisma interactive
 * transaction rolls back everything written in it, including those writes.
 * So this returns a result instead of throwing on the failure paths that
 * write anything, and the caller throws once, after the transaction has
 * already committed.
 */
export async function login(deps: AuthServiceDeps, input: LoginInput): Promise<AuthTokenPair> {
  const outcome = await withTenantContext<LoginOutcome>(deps.prisma, input.tenantId, async (tx) => {
    const user = await findUserByEmail(tx, input.tenantId, input.email);
    if (!user) {
      // Same error AND same rough latency as a wrong password: without
      // paying argon2's real hashing cost here too, a timing measurement
      // alone (not just the response body) would reveal whether the email
      // exists — this dummy hash secures nothing, it only burns the same
      // number of CPU cycles a real verification would.
      await verifyPassword(DUMMY_PASSWORD_HASH, input.password);
      return { ok: false, code: 'UNAUTHORIZED', message: 'Invalid email or password' };
    }
    if (user.status !== 'ACTIVE') {
      return { ok: false, code: 'FORBIDDEN', message: 'This account is suspended' };
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'This account is temporarily locked after repeated failed logins',
      };
    }

    const passwordValid = await verifyPassword(user.passwordHash, input.password);
    if (!passwordValid) {
      const nowLocked = await recordLoginFailure(tx, user.id);
      await recordSecurityEvent(tx, {
        tenantId: input.tenantId,
        userId: user.id,
        type: nowLocked ? SecurityEventType.ACCOUNT_LOCKED : SecurityEventType.LOGIN_FAILURE,
        severity: nowLocked ? SecuritySeverity.CRITICAL : SecuritySeverity.WARNING,
        ...(input.ip ? { ip: input.ip } : {}),
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      });

      const recentFailures = await countRecentSecurityEvents(
        tx,
        input.tenantId,
        SecurityEventType.LOGIN_FAILURE,
        new Date(Date.now() - LOGIN_VELOCITY_WINDOW_MS),
      );
      if (recentFailures >= LOGIN_VELOCITY_THRESHOLD) {
        await recordSecurityEvent(tx, {
          tenantId: input.tenantId,
          type: SecurityEventType.ANOMALY_LOGIN_VELOCITY,
          severity: SecuritySeverity.CRITICAL,
          metadata: { recentFailures, windowMs: LOGIN_VELOCITY_WINDOW_MS },
          ...(input.ip ? { ip: input.ip } : {}),
        });
      }

      return { ok: false, code: 'UNAUTHORIZED', message: 'Invalid email or password' };
    }

    if (user.mfaEnabled) {
      if (!input.mfaCode) {
        return { ok: false, code: 'UNAUTHORIZED', message: 'MFA code required', mfaRequired: true };
      }
      const secret = decryptField(user.mfaSecretCiphertext as string, deps.mfaEncryptionKey);
      const codeValid = await verifyTotpCode(secret, input.mfaCode);
      if (!codeValid) {
        await recordSecurityEvent(tx, {
          tenantId: input.tenantId,
          userId: user.id,
          type: SecurityEventType.MFA_FAILURE,
          severity: SecuritySeverity.WARNING,
          ...(input.ip ? { ip: input.ip } : {}),
        });
        return { ok: false, code: 'UNAUTHORIZED', message: 'Invalid MFA code' };
      }
    }

    await resetLoginFailures(tx, user.id);

    const newRefreshToken = issueRefreshToken();
    await createRefreshToken(tx, {
      tenantId: input.tenantId,
      userId: user.id,
      tokenHash: newRefreshToken.tokenHash,
      familyId: newRefreshToken.familyId,
      expiresAt: newRefreshToken.expiresAt,
      ...(input.ip ? { ip: input.ip } : {}),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    });

    const access = await issueAccessToken(deps, user, newRefreshToken.familyId);

    await recordSecurityEvent(tx, {
      tenantId: input.tenantId,
      userId: user.id,
      type: SecurityEventType.LOGIN_SUCCESS,
      severity: SecuritySeverity.INFO,
      ...(input.ip ? { ip: input.ip } : {}),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    });
    await new PrismaAuditWriter(tx).record({
      tenantId: input.tenantId,
      actor: user.id,
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
      requestId: input.requestId,
      ...(input.ip ? { ip: input.ip } : {}),
    });

    return {
      ok: true,
      pair: {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt.toISOString(),
        refreshToken: newRefreshToken.token,
        refreshTokenExpiresAt: newRefreshToken.expiresAt.toISOString(),
        user: toAuthenticatedUser(user),
      },
    };
  });

  if (!outcome.ok) {
    throw new AppError(outcome.code, outcome.message, {
      ...(outcome.mfaRequired ? { details: { mfaRequired: true } } : {}),
    });
  }
  return outcome.pair;
}

export interface RefreshInput extends RequestMeta {
  refreshToken: string;
  requestId: string;
}

type ExistingRefreshToken = NonNullable<Awaited<ReturnType<typeof findRefreshTokenByHash>>>;

/** Stolen-token containment: revokes every token in the family and records why. Shared by both ways reuse is discovered — see `refresh()`. */
async function containReusedTokenFamily(
  deps: AuthServiceDeps,
  existing: ExistingRefreshToken,
  meta: RequestMeta,
): Promise<void> {
  await withTenantContext(deps.prisma, existing.tenantId, (tx) =>
    Promise.all([
      revokeRefreshTokenFamily(tx, existing.familyId),
      recordSecurityEvent(tx, {
        tenantId: existing.tenantId,
        userId: existing.userId,
        type: SecurityEventType.TOKEN_REUSE_DETECTED,
        severity: SecuritySeverity.CRITICAL,
        metadata: { familyId: existing.familyId },
        ...(meta.ip ? { ip: meta.ip } : {}),
        ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
      }),
    ]),
  );
  await revokeSessionFamily(deps.redis, existing.familyId);
}

class InactiveAccountError extends Error {}
/** Thrown, never returned, specifically so the transaction that created the (now-unwanted) replacement token rolls it back — see the comment at the throw site. */
class RefreshRaceLostError extends Error {}

export async function refresh(deps: AuthServiceDeps, input: RefreshInput): Promise<AuthTokenPair> {
  const tokenHash = hashRefreshToken(input.refreshToken);
  const existing = await findRefreshTokenByHash(deps.prisma, tokenHash);
  if (!existing) {
    throw new AppError('UNAUTHORIZED', 'Invalid refresh token');
  }

  if (existing.expiresAt.getTime() < Date.now()) {
    throw new AppError('UNAUTHORIZED', 'Refresh token expired');
  }

  if (existing.revokedAt) {
    // Presenting an already-rotated-out token is a stolen-token signal — contain the whole family, not just this one token.
    await containReusedTokenFamily(deps, existing, input);
    throw new AppError(
      'UNAUTHORIZED',
      'This refresh token was already used; the session has been revoked',
    );
  }

  try {
    return await withTenantContext(deps.prisma, existing.tenantId, async (tx) => {
      const user = await findUserById(tx, existing.tenantId, existing.userId);
      if (!user || user.status !== 'ACTIVE') {
        throw new InactiveAccountError();
      }

      const rotated = rotateRefreshToken(existing.familyId);
      const newRow = await createRefreshToken(tx, {
        tenantId: existing.tenantId,
        userId: existing.userId,
        tokenHash: rotated.tokenHash,
        familyId: rotated.familyId,
        expiresAt: rotated.expiresAt,
        ...(input.ip ? { ip: input.ip } : {}),
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      });

      // Conditional, not the plain `revokeRefreshToken`: two concurrent
      // refreshes of the same token could otherwise both observe
      // `existing.revokedAt === null` above and both reach here. Losing
      // this race throws below, which rolls back `newRow` — Prisma's
      // interactive transactions roll back every write on a throw, which
      // is exactly what's wanted for this one (contrast with login()'s
      // failure paths, which need their writes to survive and so return
      // a result instead of throwing).
      const wonRace = await revokeRefreshTokenIfActive(tx, existing.id, newRow.id);
      if (!wonRace) {
        throw new RefreshRaceLostError();
      }

      const access = await issueAccessToken(deps, user, rotated.familyId);
      await new PrismaAuditWriter(tx).record({
        tenantId: existing.tenantId,
        actor: user.id,
        action: 'auth.token_refreshed',
        entityType: 'User',
        entityId: user.id,
        requestId: input.requestId,
        ...(input.ip ? { ip: input.ip } : {}),
      });

      return {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt.toISOString(),
        refreshToken: rotated.token,
        refreshTokenExpiresAt: rotated.expiresAt.toISOString(),
        user: toAuthenticatedUser(user),
      };
    });
  } catch (error) {
    if (error instanceof RefreshRaceLostError) {
      // Someone else's refresh committed first — from this caller's point
      // of view that's indistinguishable from the token having been stolen
      // and used by someone else, so it gets the same response: contain
      // the family.
      await containReusedTokenFamily(deps, existing, input);
      throw new AppError(
        'UNAUTHORIZED',
        'This refresh token was already used; the session has been revoked',
      );
    }
    if (error instanceof InactiveAccountError) {
      throw new AppError('UNAUTHORIZED', 'Account is no longer active');
    }
    throw error;
  }
}

export interface LogoutInput {
  refreshToken: string;
}

export async function logout(deps: AuthServiceDeps, input: LogoutInput): Promise<void> {
  const tokenHash = hashRefreshToken(input.refreshToken);
  const existing = await findRefreshTokenByHash(deps.prisma, tokenHash);
  if (!existing || existing.revokedAt) {
    return; // idempotent: logging out twice, or with an already-invalid token, is not an error
  }
  await withTenantContext(deps.prisma, existing.tenantId, (tx) =>
    Promise.all([
      revokeRefreshToken(tx, existing.id),
      recordSecurityEvent(tx, {
        tenantId: existing.tenantId,
        userId: existing.userId,
        type: SecurityEventType.SESSION_REVOKED,
        severity: SecuritySeverity.INFO,
        metadata: { reason: 'logout' },
      }),
    ]),
  );
  await revokeSessionFamily(deps.redis, existing.familyId);
}

export async function enrollMfa(
  deps: AuthServiceDeps,
  auth: AuthContext,
): Promise<MfaEnrollResponse> {
  return withTenantContext(deps.prisma, auth.tenantId, async (tx) => {
    const user = await findUserById(tx, auth.tenantId, auth.userId);
    if (!user) throw new AppError('NOT_FOUND', 'User not found');
    if (user.mfaEnabled) {
      // Silently overwriting a working secret would strand the user: their
      // authenticator app still has the old one, but every future login
      // would verify against the new one. There is no "disable MFA" flow
      // yet for a user to explicitly opt into re-enrolling.
      throw new AppError('CONFLICT', 'MFA is already enabled for this account');
    }
    const secret = generateTotpSecret();
    await setMfaSecret(tx, user.id, encryptField(secret, deps.mfaEncryptionKey));
    return {
      secret,
      enrollmentUri: buildTotpEnrollmentUri({
        secret,
        accountEmail: user.email,
        issuer: deps.tokenIssuer,
      }),
    };
  });
}

export async function verifyMfaEnrollment(
  deps: AuthServiceDeps,
  auth: AuthContext,
  code: string,
): Promise<void> {
  await withTenantContext(deps.prisma, auth.tenantId, async (tx) => {
    const user = await findUserById(tx, auth.tenantId, auth.userId);
    if (!user?.mfaSecretCiphertext) {
      throw new AppError('VALIDATION_FAILED', 'MFA enrollment has not been started');
    }
    const secret = decryptField(user.mfaSecretCiphertext, deps.mfaEncryptionKey);
    if (!(await verifyTotpCode(secret, code))) {
      throw new AppError('UNAUTHORIZED', 'Invalid MFA code');
    }
    await enableMfa(tx, user.id);
    await recordSecurityEvent(tx, {
      tenantId: auth.tenantId,
      userId: user.id,
      type: SecurityEventType.MFA_ENROLLED,
      severity: SecuritySeverity.INFO,
    });
  });
}

export async function getMe(deps: AuthServiceDeps, auth: AuthContext): Promise<AuthenticatedUser> {
  return withTenantContext(deps.prisma, auth.tenantId, async (tx) => {
    const user = await findUserById(tx, auth.tenantId, auth.userId);
    if (!user) throw new AppError('NOT_FOUND', 'User not found');
    return toAuthenticatedUser(user);
  });
}

export interface SetUserLockInput {
  tenantId: TenantId;
  targetUserId: string;
  actorUserId: string;
  requestId: string;
  locked: boolean;
}

/** The manual half of "automatic restricted response": an ADMIN/SECURITY operator locking or unlocking an account, immediately revoking every session on lock. */
export async function setUserLock(deps: AuthServiceDeps, input: SetUserLockInput): Promise<void> {
  const familyIds = await withTenantContext<string[]>(deps.prisma, input.tenantId, async (tx) => {
    const user = await findUserById(tx, input.tenantId, input.targetUserId);
    if (!user) throw new AppError('NOT_FOUND', 'User not found');

    const activeFamilies: string[] = input.locked
      ? await findActiveSessionFamilyIds(tx, user.id)
      : [];
    await setUserStatus(tx, user.id, input.locked ? 'SUSPENDED' : 'ACTIVE');
    if (input.locked) {
      await revokeAllRefreshTokensForUser(tx, user.id);
    }
    await recordSecurityEvent(tx, {
      tenantId: input.tenantId,
      userId: user.id,
      type: input.locked ? SecurityEventType.ACCOUNT_LOCKED : SecurityEventType.SESSION_REVOKED,
      severity: input.locked ? SecuritySeverity.CRITICAL : SecuritySeverity.INFO,
      metadata: { actorUserId: input.actorUserId, manual: true },
    });
    await new PrismaAuditWriter(tx).record({
      tenantId: input.tenantId,
      actor: input.actorUserId,
      action: input.locked ? 'user.locked' : 'user.unlocked',
      entityType: 'User',
      entityId: user.id,
      requestId: input.requestId,
    });
    return activeFamilies;
  });

  await Promise.all(familyIds.map((familyId) => revokeSessionFamily(deps.redis, familyId)));
}
