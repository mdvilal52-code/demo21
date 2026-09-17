import { MALICIOUS_PAYLOADS, seedTestTenants, truncateAllTables } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

describe('POST /v1/enquiries/:conversationId/missing-info — security', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp({ RATE_LIMIT_MAX: 1000 });
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
  });

  async function createConversation(message: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: { channel: 'WEB', customerRef: 'security-test', message },
    });
    return response.json().conversationId as string;
  }

  async function checkMissingInfo(conversationId: string) {
    return testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/missing-info`,
    });
  }

  it('surfaces a prompt-injection flag detected by an earlier step', async () => {
    const conversationId = await createConversation(
      `${MALICIOUS_PAYLOADS.promptInjection} I want to book a car, pickup in Dubai Marina`,
    );
    await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });

    const response = await checkMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);
    expect(response.json().missingInfo.flags.promptInjectionDetectedAnywhere).toBe(true);
  });

  it('treats a SQL injection payload in the conversation as inert text (no crash, no injection)', async () => {
    const conversationId = await createConversation(
      `I want to book a car ${MALICIOUS_PAYLOADS.sqlInjection}`,
    );

    const response = await checkMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);

    const count = await testApp.ctx.prisma.conversation.count();
    expect(count).toBe(1);
  });

  it('never leaks internal error details for a not-found conversation', async () => {
    const response = await checkMissingInfo('00000000-0000-0000-0000-000000009999');
    const body = response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(body)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('rejects a request for a conversation belonging to another tenant scope (defense in depth)', async () => {
    const conversationId = await createConversation('I want to book a car please');
    await testApp.ctx.prisma.conversation.update({
      where: { id: conversationId },
      data: { tenantId: '00000000-0000-0000-0000-000000000002' },
    });

    const response = await checkMissingInfo(conversationId);
    expect(response.statusCode).toBe(404);
  });
});
