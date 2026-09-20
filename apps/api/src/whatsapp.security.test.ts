import { signWebhookPayload } from '@ai-concierge/security';
import { MALICIOUS_PAYLOADS, seedTestTenants, truncateAllTables } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

const APP_SECRET = 'security-test-app-secret';
const VERIFY_TOKEN = 'security-test-verify-token';

function metaPayload(from: string, id: string, body: string) {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              messages: [{ from, id, timestamp: '1710000000', type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  });
}

function sign(raw: string, secret = APP_SECRET): string {
  return `sha256=${signWebhookPayload(raw, secret)}`;
}

describe('WhatsApp webhook — security', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp({
      RATE_LIMIT_MAX: 1000,
      WHATSAPP_APP_SECRET: APP_SECRET,
      WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    });
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
    testApp.ctx.whatsappClient = { sendTextMessage: vi.fn().mockResolvedValue(undefined) };
  });

  it('rejects a POST with no signature header', async () => {
    const raw = metaPayload('971501234567', 'wamid.NOSIG', 'hi');
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a POST signed with the wrong secret', async () => {
    const raw = metaPayload('971501234567', 'wamid.WRONGSECRET', 'hi');
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw, 'not-the-real-secret'),
      },
      payload: raw,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a POST whose body was tampered with after signing', async () => {
    const raw = metaPayload('971501234567', 'wamid.TAMPER', 'hi');
    const signature = sign(raw);
    const tampered = metaPayload('971501234567', 'wamid.TAMPER', 'something else entirely');

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      payload: tampered,
    });
    expect(response.statusCode).toBe(401);

    const count = await testApp.ctx.prisma.conversation.count();
    expect(count).toBe(0);
  });

  it('never leaks the app secret or a stack trace in the error response', async () => {
    const raw = metaPayload('971501234567', 'wamid.LEAK', 'hi');
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    const text = JSON.stringify(response.json());
    expect(text).not.toContain(APP_SECRET);
    expect(text).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('rejects malformed JSON even with a valid signature over those exact bytes', async () => {
    const raw = '{not valid json';
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a payload that is valid JSON but the wrong shape', async () => {
    const raw = JSON.stringify({ entry: 'not-an-array' });
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });
    expect(response.statusCode).toBe(400);
  });

  it('reports NOT_CONFIGURED when no app secret is set at all', async () => {
    const unconfigured = await buildTestApp({ RATE_LIMIT_MAX: 1000 });
    try {
      const raw = metaPayload('971501234567', 'wamid.NC', 'hi');
      const response = await unconfigured.app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
        payload: raw,
      });
      expect(response.statusCode).toBe(501);
      expect(response.json().error.code).toBe('NOT_CONFIGURED');
    } finally {
      await unconfigured.close();
    }
  });

  it('rejects GET verification with the wrong verify token', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=abc`,
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects GET verification with the right token but wrong mode', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=abc`,
    });
    expect(response.statusCode).toBe(403);
  });

  it('treats a prompt-injection payload in the message body as inert text (no crash, real reply)', async () => {
    const raw = metaPayload(
      '971501234567',
      'wamid.INJECT',
      `${MALICIOUS_PAYLOADS.promptInjection} I want to book a car, pickup in Dubai Marina`,
    );
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);

    const conversations = await testApp.ctx.prisma.conversation.findMany({
      include: { messages: { include: { intentRecords: true } } },
    });
    expect(conversations).toHaveLength(1);
    const flags = conversations[0]?.messages[0]?.intentRecords[0]?.flags as {
      promptInjectionDetected: boolean;
    };
    expect(flags.promptInjectionDetected).toBe(true);
  });

  it('treats a SQL injection payload in the message body as inert text (no crash, no injection)', async () => {
    const raw = metaPayload(
      '971501234567',
      'wamid.SQLI',
      `I want to book a car ${MALICIOUS_PAYLOADS.sqlInjection}`,
    );
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);

    const count = await testApp.ctx.prisma.conversation.count();
    expect(count).toBe(1);
  });
});
