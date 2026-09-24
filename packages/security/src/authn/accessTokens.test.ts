import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UserRole } from '@ai-concierge/domain';
import { ACCESS_TOKEN_TTL_SECONDS, InvalidAccessTokenError, signAccessToken, verifyAccessToken } from './accessTokens.js';

const SECRET = 'test-jwt-signing-secret-at-least-32-bytes-long';

function input() {
  return {
    userId: randomUUID(),
    tenantId: randomUUID(),
    role: UserRole.ADMIN,
    sessionFamilyId: randomUUID(),
  };
}

describe('access tokens', () => {
  it('round-trips claims through sign/verify', async () => {
    const claims = input();
    const { token } = await signAccessToken(claims, SECRET);
    const verified = await verifyAccessToken(token, SECRET);
    expect(verified.sub).toBe(claims.userId);
    expect(verified.tid).toBe(claims.tenantId);
    expect(verified.role).toBe(claims.role);
    expect(verified.jti).toBe(claims.sessionFamilyId);
  });

  it('expires <= 15 minutes from issue', async () => {
    const { expiresAt } = await signAccessToken(input(), SECRET);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000 + 1000);
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await signAccessToken(input(), SECRET);
    await expect(verifyAccessToken(token, 'a-completely-different-secret-value')).rejects.toThrow(
      InvalidAccessTokenError,
    );
  });

  it('rejects a tampered token', async () => {
    const { token } = await signAccessToken(input(), SECRET);
    const tampered = token.slice(0, -2) + (token.slice(-2) === 'aa' ? 'bb' : 'aa');
    await expect(verifyAccessToken(tampered, SECRET)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects garbage input', async () => {
    await expect(verifyAccessToken('not-a-jwt', SECRET)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects an expired token', async () => {
    const key = new TextEncoder().encode(SECRET);
    const { SignJWT } = await import('jose');
    const expiredToken = await new SignJWT({ tid: randomUUID(), role: UserRole.ADMIN })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(randomUUID())
      .setJti(randomUUID())
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(key);
    await expect(verifyAccessToken(expiredToken, SECRET)).rejects.toThrow(InvalidAccessTokenError);
  });
});
