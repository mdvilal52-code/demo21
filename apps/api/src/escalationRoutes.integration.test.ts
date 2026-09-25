import {
  seedTestTenants,
  seedTestUser,
  truncateAllTables,
  TEST_TENANT_ID,
  TEST_USER_PASSWORD,
} from '@ai-concierge/testing';
import { EligibilityDecisionStatus, MissingInfoStatus } from '@ai-concierge/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import {
  recordEligibilityOutcome,
  syncJourneyAfterMissingInfo,
} from './services/journeyService.js';
import { FakeNotificationProvider } from './test/fakeNotificationProvider.js';

/**
 * Route-level coverage (auth + permission enforcement + HTTP shape) for the
 * dashboard's Escalation Queue and Journey read surface. Deeper business
 * logic (resume-to-correct-state, assign/resolve conflicts) is already
 * covered service-level in escalationService.integration.test.ts /
 * journeyService.integration.test.ts — this file exists to prove the HTTP
 * layer wires those services correctly and actually enforces auth.
 */
describe('escalation + journey routes', () => {
  let testApp: TestApp;
  let notificationProvider: FakeNotificationProvider;

  beforeAll(async () => {
    notificationProvider = new FakeNotificationProvider();
    testApp = await buildTestApp(
      { RATE_LIMIT_MAX: 1000, AUTH_RATE_LIMIT_MAX: 1000 },
      { notificationProvider },
    );
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
  });

  async function login(email: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: TEST_USER_PASSWORD },
    });
    return response.json().accessToken as string;
  }

  async function seedEscalatedConversation() {
    const conversation = await testApp.ctx.prisma.conversation.create({
      data: { tenantId: TEST_TENANT_ID, channel: 'WHATSAPP', customerRef: '+15550009999' },
    });
    const message = await testApp.ctx.prisma.message.create({
      data: { conversationId: conversation.id, content: 'test' },
    });
    await syncJourneyAfterMissingInfo(
      { prisma: testApp.ctx.prisma, notificationProvider },
      {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        messageId: message.id,
        resolvedVehicleId: null,
        missingInfoStatus: MissingInfoStatus.COMPLETE,
        requestId: 'req-1',
      },
    );
    await recordEligibilityOutcome(
      { prisma: testApp.ctx.prisma, notificationProvider },
      {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        status: EligibilityDecisionStatus.NEEDS_HUMAN_REVIEW,
        reason: 'needs human review',
        requestId: 'req-2',
      },
    );
    return conversation;
  }

  it('rejects an unauthenticated request to list escalations', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/v1/escalations' });
    expect(response.statusCode).toBe(401);
  });

  it('an OPS_AGENT can list, assign, and resolve an escalation over real HTTP', async () => {
    await seedEscalatedConversation();
    await seedTestUser(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
    const token = await login('ops@example.com');

    const list = await testApp.app.inject({
      method: 'GET',
      url: '/v1/escalations?status=OPEN',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const { items } = list.json();
    expect(items).toHaveLength(1);

    const assign = await testApp.app.inject({
      method: 'POST',
      url: `/v1/escalations/${items[0].id}/assign`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(assign.statusCode).toBe(200);
    expect(assign.json().escalationCase.status).toBe('IN_PROGRESS');

    const resolve = await testApp.app.inject({
      method: 'POST',
      url: `/v1/escalations/${items[0].id}/resolve`,
      headers: { authorization: `Bearer ${token}` },
      payload: { resolution: 'APPROVED', resolutionNote: 'confirmed with customer' },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().escalationCase.status).toBe('RESOLVED');
  });

  it('rejects a resolve body missing a required field', async () => {
    const conversation = await seedEscalatedConversation();
    await seedTestUser(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
    const token = await login('ops@example.com');
    void conversation;

    const list = await testApp.app.inject({
      method: 'GET',
      url: '/v1/escalations?status=OPEN',
      headers: { authorization: `Bearer ${token}` },
    });
    const { items } = list.json();

    const resolve = await testApp.app.inject({
      method: 'POST',
      url: `/v1/escalations/${items[0].id}/resolve`,
      headers: { authorization: `Bearer ${token}` },
      payload: { resolution: 'APPROVED' }, // missing resolutionNote
    });
    expect(resolve.statusCode).toBe(400);
  });

  it('returns a journey with its full transition timeline over real HTTP', async () => {
    const conversation = await seedEscalatedConversation();
    await seedTestUser(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
    const token = await login('ops@example.com');

    const response = await testApp.app.inject({
      method: 'GET',
      url: `/v1/enquiries/${conversation.id}/journey`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const { journey, transitions } = response.json();
    expect(journey.state).toBe('ESCALATED');
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.at(-1).toState).toBe('ESCALATED');
  });

  it('returns 404 for a conversation with no journey', async () => {
    const conversation = await testApp.ctx.prisma.conversation.create({
      data: { tenantId: TEST_TENANT_ID, channel: 'WEB', customerRef: 'no-journey-customer' },
    });
    await seedTestUser(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
    const token = await login('ops@example.com');

    const response = await testApp.app.inject({
      method: 'GET',
      url: `/v1/enquiries/${conversation.id}/journey`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
