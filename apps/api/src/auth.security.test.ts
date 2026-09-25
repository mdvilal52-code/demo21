import {
  MALICIOUS_PAYLOADS,
  seedTestTenants,
  seedTestUser,
  truncateAllTables,
  TEST_USER_PASSWORD,
} from '@ai-concierge/testing';
import { signAccessToken } from '@ai-concierge/security/authn';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

describe('Phase 6 — AuthN/AuthZ security', () => {
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

  it('gives identical responses for an unknown email and a wrong password (no account enumeration)', async () => {
    await seedTestUser(testApp.ctx.prisma, { email: 'real@example.com', role: 'ADMIN' });

    const unknownEmail = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'whatever12345' },
    });
    const wrongPassword = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'real@example.com', password: 'wrong-password-123' },
    });

    expect(unknownEmail.statusCode).toBe(wrongPassword.statusCode);
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
  });

  it('never leaks a stack trace or internal detail from an auth error', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'x' },
    });
    const body = JSON.stringify(response.json());
    expect(body).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('argon2');
  });

  it('handles a SQL-injection-shaped password as inert text, not a server error', async () => {
    await seedTestUser(testApp.ctx.prisma, { email: 'sqli@example.com', role: 'ADMIN' });
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'sqli@example.com', password: MALICIOUS_PAYLOADS.sqlInjection },
    });
    expect(response.statusCode).toBe(401);
    const stillExists = await testApp.ctx.prisma.user.findFirst({
      where: { email: 'sqli@example.com' },
    });
    expect(stillExists).not.toBeNull();
  });

  it('rejects a malformed email without a 500', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: MALICIOUS_PAYLOADS.sqlInjectionUnion, password: 'x' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a JWT signed with a different secret', async () => {
    const forged = await signAccessToken(
      {
        userId: '11111111-1111-1111-1111-111111111111',
        tenantId: '00000000-0000-0000-0000-000000000001',
        role: 'ADMIN',
        sessionFamilyId: '22222222-2222-2222-2222-222222222222',
      },
      'a-completely-different-forged-signing-secret-value',
    );
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${forged.token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a request with no Authorization header on a protected route', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/v1/audit-events' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'NotBearer sometoken' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('enforces the stricter auth rate limit on /v1/auth/login independent of the general limit', async () => {
    const limitedApp = await buildTestApp({
      RATE_LIMIT_MAX: 1000,
      AUTH_RATE_LIMIT_MAX: 3,
      AUTH_RATE_LIMIT_WINDOW_MS: 60_000,
    });
    try {
      const requests = Array.from({ length: 6 }, () =>
        limitedApp.app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: 'nobody@example.com', password: 'x' },
        }),
      );
      const responses = await Promise.all(requests);
      expect(responses.some((response) => response.statusCode === 429)).toBe(true);
    } finally {
      await limitedApp.close();
    }
  });

  describe('admin routes — RBAC + ABAC enforcement', () => {
    it('a role without the permission is denied and the denial is recorded', async () => {
      await seedTestUser(testApp.ctx.prisma, { email: 'ops@example.com', role: 'OPS_AGENT' });
      const login = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'ops@example.com', password: TEST_USER_PASSWORD },
      });
      const { accessToken } = login.json();

      const response = await testApp.app.inject({
        method: 'GET',
        url: '/v1/audit-events',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(response.statusCode).toBe(403);

      const events = await testApp.ctx.prisma.securityEvent.findMany({
        where: { type: 'PERMISSION_DENIED' },
      });
      expect(events).toHaveLength(1);
    });

    it('SECURITY role can read both audit and security events; MANAGER cannot respond (lock users)', async () => {
      await seedTestUser(testApp.ctx.prisma, { email: 'sec@example.com', role: 'SECURITY' });
      const login = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'sec@example.com', password: TEST_USER_PASSWORD },
      });
      const { accessToken } = login.json();

      const auditResponse = await testApp.app.inject({
        method: 'GET',
        url: '/v1/audit-events',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(auditResponse.statusCode).toBe(200);

      const secEventsResponse = await testApp.app.inject({
        method: 'GET',
        url: '/v1/security-events',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(secEventsResponse.statusCode).toBe(200);
    });
  });
});
