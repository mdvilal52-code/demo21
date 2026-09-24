import {
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
  setMfaSecret,
  setUserStatus,
  withTenantContext,
  type PrismaClient,
  type User,
} from '@ai-concierge/db';
import {
  buildTotpEnrollmentUri,
  decryptField,
  encryptField,
  generateTotpSecret,
  hashPassword,
  hashRefreshToken,
  issueRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyPassword,
  verifyTotpCode,
} from '@ai-concierge/security';
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

export async function login(deps: AuthServiceDeps, input: LoginInput): Promise<AuthTokenPair> {
  return withTenantContext(deps.prisma, input.tenantId, async (tx) => {
    const user = await findUserByEmail(tx, input.tenantId, input.email);
    if (!user) {
      // Same error as a wrong password — never reveal whether the account exists.
      throw new AppError('UNAUTHORIZED', 'Invalid email or password');
    }
    if (user.status !== 'ACTIVE') {
      throw new AppError('FORBIDDEN', 'This account is suspended');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(
        'FORBIDDEN',
        'This account is temporarily locked after repeated failed logins',
      );
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
      throw new AppError('UNAUTHORIZED', 'Invalid email or password');
    }

    if (user.mfaEnabled) {
      if (!input.mfaCode) {
        throw new AppError('UNAUTHORIZED', 'MFA code required', { details: { mfaRequired: true } });
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
        throw new AppError('UNAUTHORIZED', 'Invalid MFA code');
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
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: newRefreshToken.token,
      refreshTokenExpiresAt: newRefreshToken.expiresAt.toISOString(),
      user: toAuthenticatedUser(user),
    };
  });
}

export interface RefreshInput extends RequestMeta {
  refreshToken: string;
}

export async function refresh(deps: AuthServiceDeps, input: RefreshInput): Promise<AuthTokenPair> {
  const tokenHash = hashRefreshToken(input.refreshToken);
  const existing = await findRefreshTokenByHash(deps.prisma, tokenHash);
  if (!existing) {
    throw new AppError('UNAUTHORIZED', 'Invalid refresh token');
  }

  if (existing.revokedAt) {
    // Presenting an already-rotated-out token is a stolen-token signal — contain the whole family, not just this one token.
    await withTenantContext(deps.prisma, existing.tenantId, (tx) =>
      Promise.all([
        revokeRefreshTokenFamily(tx, existing.familyId),
        recordSecurityEvent(tx, {
          tenantId: existing.tenantId,
          userId: existing.userId,
          type: SecurityEventType.TOKEN_REUSE_DETECTED,
          severity: SecuritySeverity.CRITICAL,
          metadata: { familyId: existing.familyId },
          ...(input.ip ? { ip: input.ip } : {}),
          ...(input.userAgent ? { userAgent: input.userAgent } : {}),
        }),
      ]),
    );
    await revokeSessionFamily(deps.redis, existing.familyId);
    throw new AppError(
      'UNAUTHORIZED',
      'This refresh token was already used; the session has been revoked',
    );
  }

  if (existing.expiresAt.getTime() < Date.now()) {
    throw new AppError('UNAUTHORIZED', 'Refresh token expired');
  }

  return withTenantContext(deps.prisma, existing.tenantId, async (tx) => {
    const user = await findUserById(tx, existing.tenantId, existing.userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new AppError('UNAUTHORIZED', 'Account is no longer active');
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
    await revokeRefreshToken(tx, existing.id, newRow.id);

    const access = await issueAccessToken(deps, user, rotated.familyId);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: rotated.token,
      refreshTokenExpiresAt: rotated.expiresAt.toISOString(),
      user: toAuthenticatedUser(user),
    };
  });
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
