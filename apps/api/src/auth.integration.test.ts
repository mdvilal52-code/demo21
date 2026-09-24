import {
  seedTestTenants,
  seedTestUser,
  truncateAllTables,
  TEST_USER_PASSWORD,
} from '@ai-concierge/testing';
import { generateCurrentTotpCode } from '@ai-concierge/security/authn';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

describe('Phase 6 — AuthN integration', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp({ RATE_LIMIT_MAX: 1000, AUTH_RATE_LIMIT_MAX: 1000 });
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
  });

  it('logs in with correct credentials and never leaks the password hash', async () => {
    await seedTestUser(testApp.ctx.prisma, { email: 'admin@example.com', role: 'ADMIN' });

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@example.com', password: TEST_USER_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.email).toBe('admin@example.com');
    expect(body.user.role).toBe('ADMIN');
    expect(body).not.toHaveProperty('user.passwordHash');
    expect(JSON.stringify(body)).not.toContain(TEST_USER_PASSWORD);
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
  });

  it('GET /v1/auth/me returns the authenticated user with a valid access token', async () => {
    await seedTestUser(testApp.ctx.prisma, { email: 'me@example.com', role: 'OPS_AGENT' });
    const login = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'me@example.com', password: TEST_USER_PASSWORD },
    });
    const { accessToken } = login.json();

    const response = await testApp.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().email).toBe('me@example.com');
  });

  it('GET /v1/auth/me without a token is 401', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('locks the account after repeated failed logins, then rejects even the correct password', async () => {
    await seedTestUser(testApp.ctx.prisma, { email: 'lockme@example.com', role: 'ADMIN' });

    let last;
    for (let i = 0; i < 5; i++) {
      last = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'lockme@example.com', password: 'wrong-password' },
      });
    }
    expect(last?.statusCode).toBe(401);

    const correctPasswordAttempt = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'lockme@example.com', password: TEST_USER_PASSWORD },
    });
    expect(correctPasswordAttempt.statusCode).toBe(403);
  });

  it('a suspended account cannot log in even with the correct password', async () => {
    const user = await seedTestUser(testApp.ctx.prisma, {
      email: 'suspended@example.com',
      role: 'ADMIN',
    });
    await testApp.ctx.prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'suspended@example.com', password: TEST_USER_PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  describe('MFA enrollment and step-up', () => {
    async function loginAndGetAccessToken(email: string): Promise<string> {
      const login = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: TEST_USER_PASSWORD },
      });
      return login.json().accessToken;
    }

    it('enrolls, verifies, then requires a code on the next login', async () => {
      await seedTestUser(testApp.ctx.prisma, { email: 'mfa@example.com', role: 'ADMIN' });
      const accessToken = await loginAndGetAccessToken('mfa@example.com');

      const enroll = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/mfa/enroll',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(enroll.statusCode).toBe(200);
      const { secret, enrollmentUri } = enroll.json();
      expect(enrollmentUri).toMatch(/^otpauth:\/\/totp\//);

      const code = await generateCurrentTotpCode(secret);
      const verify = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/mfa/verify',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { code },
      });
      expect(verify.statusCode).toBe(200);
      expect(verify.json()).toEqual({ mfaEnabled: true });

      // Password alone is no longer enough.
      const noCode = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'mfa@example.com', password: TEST_USER_PASSWORD },
      });
      expect(noCode.statusCode).toBe(401);
      expect(noCode.json().error.details.mfaRequired).toBe(true);

      const wrongCode = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'mfa@example.com', password: TEST_USER_PASSWORD, mfaCode: '000000' },
      });
      expect(wrongCode.statusCode).toBe(401);

      const rightCode = await generateCurrentTotpCode(secret);
      const success = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'mfa@example.com', password: TEST_USER_PASSWORD, mfaCode: rightCode },
      });
      expect(success.statusCode).toBe(200);
    });
  });

  describe('refresh token rotation and reuse detection', () => {
    async function login(email: string) {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: TEST_USER_PASSWORD },
      });
      return response.json();
    }

    it('rotates the refresh token on every use', async () => {
      await seedTestUser(testApp.ctx.prisma, { email: 'rotate@example.com', role: 'ADMIN' });
      const first = await login('rotate@example.com');

      const refreshed = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: first.refreshToken },
      });
      expect(refreshed.statusCode).toBe(200);
      const second = refreshed.json();
      // Only the refresh token is guaranteed to differ — an access token
      // reissued for the same still-live family within the same second is
      // byte-identical by construction (deterministic HS256 over identical
      // claims), which is not a security property this test should assert.
      expect(second.refreshToken).not.toBe(first.refreshToken);
    });

    it('detects reuse of an already-rotated token and revokes the whole session', async () => {
      await seedTestUser(testApp.ctx.prisma, { email: 'reuse@example.com', role: 'ADMIN' });
      const first = await login('reuse@example.com');

      const rotated = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: first.refreshToken },
      });
      const second = rotated.json();

      // Presenting the old (already-rotated-out) token again is the reuse signal.
      const reuseAttempt = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: first.refreshToken },
      });
      expect(reuseAttempt.statusCode).toBe(401);

      // The whole family is now dead — even the second (legitimately rotated) token no longer works.
      const secondNowDead = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: second.refreshToken },
      });
      expect(secondNowDead.statusCode).toBe(401);

      // Two separate presentations of an already-revoked token (the original,
      // then the now-also-revoked rotated one) — each is its own reuse signal.
      const events = await testApp.ctx.prisma.securityEvent.findMany({
        where: { type: 'TOKEN_REUSE_DETECTED' },
      });
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.severity === 'CRITICAL')).toBe(true);
    });

    it('rejects an unknown refresh token', async () => {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: 'not-a-real-token' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('logout', () => {
    it('revokes the refresh token so it can no longer be used', async () => {
      await seedTestUser(testApp.ctx.prisma, { email: 'logout@example.com', role: 'ADMIN' });
      const login = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'logout@example.com', password: TEST_USER_PASSWORD },
      });
      const { refreshToken } = login.json();

      const logoutResponse = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload: { refreshToken },
      });
      expect(logoutResponse.statusCode).toBe(204);

      const afterLogout = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken },
      });
      expect(afterLogout.statusCode).toBe(401);
    });

    it('is idempotent — logging out twice is not an error', async () => {
      await seedTestUser(testApp.ctx.prisma, { email: 'logout2@example.com', role: 'ADMIN' });
      const login = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'logout2@example.com', password: TEST_USER_PASSWORD },
      });
      const { refreshToken } = login.json();

      await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload: { refreshToken },
      });
      const second = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload: { refreshToken },
      });
      expect(second.statusCode).toBe(204);
    });
  });

  describe('user lock / unlock — automatic restricted response', () => {
    it('locking a user immediately kills their live session', async () => {
      await seedTestUser(testApp.ctx.prisma, { email: 'operator@example.com', role: 'ADMIN' });
      const target = await seedTestUser(testApp.ctx.prisma, {
        email: 'suspect@example.com',
        role: 'OPS_AGENT',
      });

      const adminLogin = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'operator@example.com', password: TEST_USER_PASSWORD },
      });
      const { accessToken: adminAccessToken } = adminLogin.json();

      const targetLogin = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'suspect@example.com', password: TEST_USER_PASSWORD },
      });
      const { accessToken: targetAccessToken, refreshToken: targetRefreshToken } =
        targetLogin.json();

      const lockResponse = await testApp.app.inject({
        method: 'POST',
        url: `/v1/users/${target.id}/lock`,
        headers: { authorization: `Bearer ${adminAccessToken}` },
      });
      expect(lockResponse.statusCode).toBe(204);

      // The still-unexpired access token is now rejected via the Redis revocation set.
      const meAfterLock = await testApp.app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${targetAccessToken}` },
      });
      expect(meAfterLock.statusCode).toBe(401);

      // The refresh token is revoked too.
      const refreshAfterLock = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: targetRefreshToken },
      });
      expect(refreshAfterLock.statusCode).toBe(401);

      // And the account can no longer log in at all.
      const loginAfterLock = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'suspect@example.com', password: TEST_USER_PASSWORD },
      });
      expect(loginAfterLock.statusCode).toBe(403);
    });

    it('a non-ADMIN/SECURITY role cannot lock a user', async () => {
      await seedTestUser(testApp.ctx.prisma, { email: 'manager@example.com', role: 'MANAGER' });
      const target = await seedTestUser(testApp.ctx.prisma, {
        email: 'target2@example.com',
        role: 'OPS_AGENT',
      });
      const managerLogin = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'manager@example.com', password: TEST_USER_PASSWORD },
      });
      const { accessToken } = managerLogin.json();

      const response = await testApp.app.inject({
        method: 'POST',
        url: `/v1/users/${target.id}/lock`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(response.statusCode).toBe(403);
    });
  });
});
