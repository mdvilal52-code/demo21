import { seedTestTenants, truncateAllTables, OTHER_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

describe('POST /v1/enquiries/:conversationId/messages — integration', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp();
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
      payload: { channel: 'WEB', customerRef: 'web-session-1', message },
    });
    expect(response.statusCode).toBe(201);
    return response.json().conversationId as string;
  }

  it('appends a follow-up message to an existing conversation', async () => {
    const conversationId = await createConversation('I need a car');

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/messages`,
      payload: { message: 'my flight is EK203' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.conversationId).toBe(conversationId);
    expect(body.messageId).toBeDefined();

    const messageCount = await testApp.ctx.prisma.message.count({ where: { conversationId } });
    expect(messageCount).toBe(2);
  });

  it('replays the same response for a repeated Idempotency-Key without appending the message twice', async () => {
    const conversationId = await createConversation('I need a car');
    const payload = { message: 'my flight is EK203' };

    const first = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/messages`,
      headers: { 'idempotency-key': 'reply-idem-key-1' },
      payload,
    });
    const second = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/messages`,
      headers: { 'idempotency-key': 'reply-idem-key-1' },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().messageId).toBe(second.json().messageId);

    const messageCount = await testApp.ctx.prisma.message.count({ where: { conversationId } });
    expect(messageCount).toBe(2); // original enquiry + exactly one reply, not two
  });

  it('writes an audit event without the raw message content', async () => {
    const conversationId = await createConversation('I need a car');
    await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/messages`,
      payload: { message: 'my email is jane@example.com' },
    });

    const auditRows = await testApp.ctx.prisma.auditEvent.findMany({
      where: { action: 'conversation.message_appended' },
    });
    expect(auditRows).toHaveLength(1);
    expect(JSON.stringify(auditRows[0]?.after)).not.toContain('jane@example.com');
  });

  it('returns 400 for an empty message', async () => {
    const conversationId = await createConversation('I need a car');
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/messages`,
      payload: { message: '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for an unknown conversation', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries/00000000-0000-0000-0000-000000009999/messages',
      payload: { message: 'hello' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for a malformed conversation id', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries/not-a-uuid/messages',
      payload: { message: 'hello' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a conversation belonging to another tenant scope (defense in depth)', async () => {
    const conversationId = await createConversation('I need a car');
    await testApp.ctx.prisma.conversation.update({
      where: { id: conversationId },
      data: { tenantId: OTHER_TENANT_ID },
    });

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/messages`,
      payload: { message: 'hello' },
    });
    expect(response.statusCode).toBe(404);
  });
});
