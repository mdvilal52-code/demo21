import { SignJWT, jwtVerify } from 'jose';
import {
  accessTokenClaimsSchema,
  type AccessTokenClaims,
  type UserRoleValue,
} from '@ai-concierge/domain';

/** MASTER-PLAN.md §3: "short-lived access tokens (<=15 min)". */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface IssueAccessTokenInput {
  userId: string;
  tenantId: string;
  role: UserRoleValue;
  /**
   * The issuing refresh token's `familyId`, carried as the JWT's `jti`.
   * Lets an immediate "revoke this session" response invalidate live access
   * tokens too (apps/api checks `jti` against a Redis revocation set), not
   * just future refreshes — see docs/SECURITY-MODEL.md's detection &
   * response section.
   */
  sessionFamilyId: string;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

export async function signAccessToken(
  input: IssueAccessTokenInput,
  secret: string,
): Promise<IssuedAccessToken> {
  const key = new TextEncoder().encode(secret);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = nowSeconds + ACCESS_TOKEN_TTL_SECONDS;

  const token = await new SignJWT({ tid: input.tenantId, role: input.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.userId)
    .setJti(input.sessionFamilyId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expSeconds)
    .sign(key);

  return { token, expiresAt: new Date(expSeconds * 1000) };
}

export class InvalidAccessTokenError extends Error {
  constructor(cause?: unknown) {
    super('Access token is missing, malformed, expired, or has an invalid signature');
    this.name = 'InvalidAccessTokenError';
    this.cause = cause;
  }
}

/** Verifies signature + expiry + shape. Does not check the Redis revocation set — that is apps/api's job (needs a Redis connection, which this package deliberately does not depend on). */
export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenClaims> {
  const key = new TextEncoder().encode(secret);
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    return accessTokenClaimsSchema.parse(payload);
  } catch (error) {
    throw new InvalidAccessTokenError(error);
  }
}
