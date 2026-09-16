import { seedTestTenants, truncateAllTables, MALICIOUS_PAYLOADS } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

describe('POST /v1/enquiries/:conversationId/missing-information — security', () => {
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

  async function createConversation(message: string, channel: 'WHATSAPP' | 'WEB' = 'WEB') {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: { channel, customerRef: 'security-test', message },
    });
    return response;
  }

  async function runSteps123(message: string, channel: 'WHATSAPP' | 'WEB' = 'WEB') {
    const created = await createConversation(message, channel);
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().conversationId as string;
    await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });
    await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/vehicle-selection`,
    });
    return conversationId;
  }

  async function reply(conversationId: string, message: string) {
    return testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/messages`,
      payload: { message },
    });
  }

  async function collectMissingInfo(conversationId: string) {
    return testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/missing-information`,
    });
  }

  it('flags a prompt-injection reply but never fast-tracks completion or leaks internal text', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport');
    await collectMissingInfo(conversationId);

    const replyResponse = await reply(conversationId, MALICIOUS_PAYLOADS.promptInjection);
    expect(replyResponse.statusCode).toBe(201);

    const response = await collectMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);
    const { result } = response.json();
    expect(result.flags.promptInjectionDetected).toBe(true);
    expect(result.status).toBe('AWAITING_CUSTOMER'); // real required fields are still unanswered
    expect(JSON.stringify(result)).not.toMatch(/system prompt/i);
  });

  it('flags a role-play injection attempt without granting anything it asks for', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport');
    await collectMissingInfo(conversationId);

    await reply(conversationId, MALICIOUS_PAYLOADS.promptInjectionRolePlay);
    const response = await collectMissingInfo(conversationId);
    const { result } = response.json();
    expect(result.flags.promptInjectionDetected).toBe(true);
    expect(result.missingFields.length).toBeGreaterThan(0);
  });

  it('treats an HTML/script payload as inert text with no crash through the full Steps 1-4 pipeline', async () => {
    const conversationId = await runSteps123(MALICIOUS_PAYLOADS.htmlXss);
    const response = await collectMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);
    expect(JSON.stringify(response.json())).not.toContain('<script>');
  });

  it('treats a SQL-injection-shaped reply as inert text (no crash, no data loss)', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport');
    await collectMissingInfo(conversationId);

    const replyResponse = await reply(conversationId, MALICIOUS_PAYLOADS.sqlInjection);
    expect(replyResponse.statusCode).toBe(201);
    const response = await collectMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);

    const conversationCount = await testApp.ctx.prisma.conversation.count();
    expect(conversationCount).toBe(1);
  });

  it('rejects an extremely long message with a structured validation error, never a crash', async () => {
    const response = await createConversation(MALICIOUS_PAYLOADS.extremelyLong);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('never captures unrelated PII (a passport number) as an answer to any field', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport');
    await collectMissingInfo(conversationId);

    await reply(conversationId, 'My passport is A1234567 and my email is jane@example.com');
    const response = await collectMissingInfo(conversationId);
    const { result } = response.json();

    expect(result.flags.piiDetected).toBe(true);
    const answers = result.answers as Array<{ value: unknown }>;
    expect(answers.every((a) => typeof a.value !== 'string' || !a.value.includes('A1234567'))).toBe(
      true,
    );
  });

  it('never stores raw PII-bearing answer values in the audit trail', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport');
    await collectMissingInfo(conversationId);
    await reply(conversationId, 'reach me at jane@example.com');
    await collectMissingInfo(conversationId);

    const auditRows = await testApp.ctx.prisma.auditEvent.findMany({
      where: { action: 'missing_information.evaluated' },
    });
    for (const row of auditRows) {
      expect(JSON.stringify(row.after)).not.toContain('jane@example.com');
    }
  });

  it('never leaks internal error details for a not-found conversation', async () => {
    const response = await collectMissingInfo('00000000-0000-0000-0000-000000009999');
    const body = response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(body)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('never leaks internal error details for a Step 1-3 precondition failure', async () => {
    const created = await createConversation('I need a car');
    const conversationId = created.json().conversationId as string;
    const response = await collectMissingInfo(conversationId);
    const body = response.json();
    expect(body.error.code).toBe('CONFLICT');
    expect(JSON.stringify(body)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });
});
