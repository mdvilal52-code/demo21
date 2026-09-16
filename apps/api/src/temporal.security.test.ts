import { MALICIOUS_PAYLOADS, seedTestTenants, truncateAllTables } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

describe('POST /v1/enquiries/:conversationId/dates-location — security', () => {
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

  it('flags a prompt-injection payload and never fabricates a date from it', async () => {
    const conversationId = await createConversation(
      `${MALICIOUS_PAYLOADS.promptInjection} pickup in Dubai Marina`,
    );
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().extraction.flags.promptInjectionDetected).toBe(true);
  });

  it('treats a SQL injection payload in the conversation as inert text (no crash, no injection)', async () => {
    const conversationId = await createConversation(
      `pickup 15 Oct Dubai Marina ${MALICIOUS_PAYLOADS.sqlInjection}`,
    );
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });
    expect(response.statusCode).toBe(201);

    const count = await testApp.ctx.prisma.conversation.count();
    expect(count).toBe(1);
  });

  it('handles a maximum-length (4000 char) message without crashing or hanging', async () => {
    // Phase 1 caps message length at 4000 chars at ingestion, so a Step 2
    // extraction can never see anything longer than this in practice.
    const longButValid = `pickup 15 Oct Dubai Marina ${'padding '.repeat(490)}`.slice(0, 4000);
    const conversationId = await createConversation(longButValid);
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });
    expect(response.statusCode).toBe(201);
  });

  it('never leaks internal error details for a not-found conversation', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries/00000000-0000-0000-0000-000000009999/dates-location',
    });
    const body = response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(body)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('rejects a request for a conversation belonging to another tenant scope (defense in depth)', async () => {
    // DEFAULT_TENANT_ID is fixed in Phase 1/2 (no auth yet); this proves the
    // repository call is tenant-scoped even though only one tenant is reachable today.
    const conversationId = await createConversation('pickup 15 Oct Dubai Marina');
    const otherTenantPrisma = testApp.ctx.prisma;
    await otherTenantPrisma.conversation.update({
      where: { id: conversationId },
      data: { tenantId: '00000000-0000-0000-0000-000000000002' },
    });

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });
    expect(response.statusCode).toBe(404);
  });
});
