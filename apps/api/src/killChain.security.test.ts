import {
  seedTestTenants,
  seedTestUser,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
  TEST_USER_PASSWORD,
} from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

/**
 * Compromised-account kill-chain test (MASTER-PLAN.md §6 Phase 6 acceptance:
 * "kill-chain test proves each layer contains a compromised account"). One
 * continuous narrative through every layer this phase built, over the real
 * HTTP API and real Postgres — not a re-statement of the unit/integration
 * tests for each mechanism in isolation (those already exist: policy.test.ts
 * for the authz matrix, rowLevelSecurity.security.test.ts for RLS,
 * auth.integration.test.ts for token rotation/reuse). This test's job is to
 * prove the *chain* holds together end to end, the way a real incident
 * would actually unfold.
 */
describe('Compromised-account kill chain', () => {
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

  async function login(email: string, password = TEST_USER_PASSWORD) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    return { statusCode: response.statusCode, body: response.json() };
  }

  it('contains a compromised low-privilege account at the AuthZ layer', async () => {
    // Layer 1 — AuthN: the attacker has valid stolen credentials for a real
    // OPS_AGENT account. The password is genuinely correct, so login itself
    // succeeds — the system's job starts after this, not before it.
    const victim = await seedTestUser(testApp.ctx.prisma, {
      email: 'ops-victim@example.com',
      role: 'OPS_AGENT',
    });
    const attackerSession = await login('ops-victim@example.com');
    expect(attackerSession.statusCode).toBe(200);
    const attackerAccessToken = attackerSession.body.accessToken;

    // Layer 2 — AuthZ: the stolen session is real, but OPS_AGENT carries
    // none of the admin-read permissions. Every attempt to reach the
    // security/audit surface is denied and recorded.
    const auditAttempt = await testApp.app.inject({
      method: 'GET',
      url: '/v1/audit-events',
      headers: { authorization: `Bearer ${attackerAccessToken}` },
    });
    expect(auditAttempt.statusCode).toBe(403);

    const lockAttempt = await testApp.app.inject({
      method: 'POST',
      url: `/v1/users/${victim.id}/lock`,
      headers: { authorization: `Bearer ${attackerAccessToken}` },
    });
    expect(lockAttempt.statusCode).toBe(403);

    const denials = await testApp.ctx.prisma.securityEvent.count({
      where: { type: 'PERMISSION_DENIED' },
    });
    expect(denials).toBe(2); // both attempts are visible to a security operator
  });

  it('contains a compromised admin account at the tenant-isolation layer', async () => {
    // A real ADMIN account, in tenant A, is fully compromised — the
    // strongest role this system has. Even so, it was provisioned for
    // tenant A and has no way to reach tenant B's data.
    await seedTestUser(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      email: 'admin-a@example.com',
      role: 'ADMIN',
    });
    await seedTestUser(testApp.ctx.prisma, {
      tenantId: OTHER_TENANT_ID,
      email: 'admin-b@example.com',
      role: 'ADMIN',
    });
    // A real audit trail exists in both tenants. Tenant A's comes from a
    // real login through the API below; tenant B's is seeded directly
    // (there is no tenant-selection step in /v1/auth/login yet — every
    // route in this codebase still resolves to DEFAULT_TENANT_ID, the same
    // established single-tenant constraint every other Phase 1-5 endpoint
    // has — so a *second* tenant's own activity has to be created directly
    // for this test, not by attempting to log into it via the API).
    await testApp.ctx.prisma.auditEvent.create({
      data: {
        tenantId: OTHER_TENANT_ID,
        actor: 'system',
        action: 'auth.login',
        entityType: 'User',
        entityId: 'tenant-b-admin',
      },
    });

    const attackerSession = await login('admin-a@example.com');
    const attackerAccessToken = attackerSession.body.accessToken;

    const events = await testApp.app.inject({
      method: 'GET',
      url: '/v1/audit-events',
      headers: { authorization: `Bearer ${attackerAccessToken}` },
    });
    expect(events.statusCode).toBe(200);

    // Every row returned actually belongs to tenant A — proven from the
    // database directly, not just trusted from the response shape.
    const allTenantAAuditEventIds = (
      await testApp.ctx.prisma.auditEvent.findMany({ where: { tenantId: TEST_TENANT_ID } })
    ).map((row) => row.id);
    const allTenantBAuditEventIds = (
      await testApp.ctx.prisma.auditEvent.findMany({ where: { tenantId: OTHER_TENANT_ID } })
    ).map((row) => row.id);
    expect(allTenantBAuditEventIds.length).toBeGreaterThan(0); // tenant B really does have data to leak
    for (const item of events.json().items as Array<{ id: string }>) {
      expect(allTenantAAuditEventIds).toContain(item.id);
      expect(allTenantBAuditEventIds).not.toContain(item.id);
    }
  });

  it('contains a stolen refresh token via reuse detection, then a human operator finishes the job', async () => {
    await seedTestUser(testApp.ctx.prisma, { email: 'target@example.com', role: 'ADMIN' });
    await seedTestUser(testApp.ctx.prisma, {
      email: 'security-oncall@example.com',
      role: 'SECURITY',
    });

    // Layer 1 — the attacker steals both tokens (e.g. via a compromised
    // device or MITM) from the legitimate user's real session.
    const stolen = await login('target@example.com');
    const stolenRefreshToken = stolen.body.refreshToken;

    // Layer 2 — token-theft containment: the legitimate user refreshes
    // first (ordinary session renewal), rotating the token. The attacker's
    // copy is now stale.
    await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: stolenRefreshToken },
    });

    // The attacker then tries to use their stolen (now-rotated-out) copy.
    // This is indistinguishable from the legitimate refresh at the moment
    // it's presented — which is exactly why reuse detection, not trust,
    // is the containment mechanism: presenting an already-used token at
    // all is treated as compromise, and the entire session is killed.
    const attackerReplay = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: stolenRefreshToken },
    });
    expect(attackerReplay.statusCode).toBe(401);

    // Even the legitimate user's just-rotated, still-unexpired access token
    // is now dead — the whole family was revoked, not just the stolen token.
    const legitimateUserNowLockedOut = await testApp.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${stolen.body.accessToken}` },
    });
    expect(legitimateUserNowLockedOut.statusCode).toBe(401);

    // Layer 3 — visibility: a SECURITY operator sees the incident.
    const secLogin = await login('security-oncall@example.com');
    const events = await testApp.app.inject({
      method: 'GET',
      url: '/v1/security-events?severity=CRITICAL',
      headers: { authorization: `Bearer ${secLogin.body.accessToken}` },
    });
    expect(events.statusCode).toBe(200);
    const reuseEvent = events
      .json()
      .items.find((item: { type: string }) => item.type === 'TOKEN_REUSE_DETECTED');
    expect(reuseEvent).toBeDefined();

    // Layer 4 — human response: the operator locks the affected account
    // outright. Even a correct, un-stolen password no longer works.
    const targetUser = await testApp.ctx.prisma.user.findFirstOrThrow({
      where: { email: 'target@example.com' },
    });
    const lockResponse = await testApp.app.inject({
      method: 'POST',
      url: `/v1/users/${targetUser.id}/lock`,
      headers: { authorization: `Bearer ${secLogin.body.accessToken}` },
    });
    expect(lockResponse.statusCode).toBe(204);

    const finalLoginAttempt = await login('target@example.com');
    expect(finalLoginAttempt.statusCode).toBe(403);
  });
});
