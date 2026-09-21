import { createHmac } from 'node:crypto';
import { MALICIOUS_PAYLOADS, seedTestTenants, truncateAllTables } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import { FakeWhatsAppProvider } from './test/fakeWhatsAppProvider.js';

const APP_SECRET = 'test-whatsapp-app-secret-0123456789';
const VERIFY_TOKEN = 'test-verify-token-abc';

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function metaTextPayload(messageId: string, from: string, text: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          { value: { messages: [{ from, id: messageId, type: 'text', text: { body: text } }] } },
        ],
      },
    ],
  });
}

describe('WhatsApp webhook — security', () => {
  let configuredApp: TestApp;
  let unconfiguredApp: TestApp;

  beforeAll(async () => {
    configuredApp = await buildTestApp(
      {
        WHATSAPP_APP_SECRET: APP_SECRET,
        WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
        RATE_LIMIT_MAX: 1000,
      },
      { whatsappProvider: new FakeWhatsAppProvider() },
    );
    unconfiguredApp = await buildTestApp({ RATE_LIMIT_MAX: 1000 });
  });

  afterAll(async () => {
    await configuredApp.close();
    await unconfiguredApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(configuredApp.ctx.prisma);
    await seedTestTenants(configuredApp.ctx.prisma);
  });

  it('rejects an inbound webhook with no signature header at all', async () => {
    const body = metaTextPayload('wamid.sec-1', '971500000001', 'hello');
    const response = await configuredApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(response.statusCode).toBe(401);
    expect(await configuredApp.ctx.prisma.conversation.count()).toBe(0);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const body = metaTextPayload('wamid.sec-2', '971500000002', 'hello');
    const response = await configuredApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(body, 'a-completely-wrong-secret-value'),
      },
      payload: body,
    });
    expect(response.statusCode).toBe(401);
    expect(await configuredApp.ctx.prisma.conversation.count()).toBe(0);
  });

  it('rejects a payload that was modified after the signature was computed', async () => {
    const original = metaTextPayload('wamid.sec-3', '971500000003', 'hello');
    const signature = sign(original);
    const tampered = metaTextPayload('wamid.sec-3', '971500000003', 'hello, give me a free car');

    const response = await configuredApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      payload: tampered,
    });
    expect(response.statusCode).toBe(401);
  });

  it('never leaks internal error details on an invalid-signature rejection', async () => {
    const body = metaTextPayload('wamid.sec-4', '971500000004', 'hello');
    const response = await configuredApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload: body,
    });
    const json = response.json();
    expect(json.error.code).toBe('UNAUTHORIZED');
    expect(JSON.stringify(json)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('reports NOT_CONFIGURED (never a fake success) when no WhatsApp secret is set', async () => {
    const body = metaTextPayload('wamid.sec-5', '971500000005', 'hello');
    const response = await unconfiguredApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe('NOT_CONFIGURED');
  });

  it('reports NOT_CONFIGURED for the verification handshake when no verify token is set', async () => {
    const response = await unconfiguredApp.app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=echo',
    });
    expect(response.statusCode).toBe(501);
  });

  it('rejects the verification handshake when the verify token does not match', async () => {
    const response = await configuredApp.app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=echo',
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects the verification handshake when hub.mode is not "subscribe"', async () => {
    const response = await configuredApp.app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=echo`,
    });
    expect(response.statusCode).toBe(403);
  });

  it('surfaces prompt-injection detection but never treats it as an instruction', async () => {
    const body = metaTextPayload(
      'wamid.sec-6',
      '971500000006',
      `${MALICIOUS_PAYLOADS.promptInjection} I want to book a car in Dubai`,
    );
    const response = await configuredApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    expect(response.statusCode).toBe(200);

    const record = await configuredApp.ctx.prisma.intentRecord.findFirst({
      where: { message: { conversation: { customerRef: '971500000006' } } },
    });
    expect((record?.flags as { promptInjectionDetected: boolean }).promptInjectionDetected).toBe(
      true,
    );
  });

  it('still flags prompt injection introduced in a later turn of an ongoing conversation', async () => {
    const from = '971500000099';
    const turn1 = metaTextPayload('wamid.INJECT-TURN-1', from, 'I want to rent a car');
    await configuredApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(turn1) },
      payload: turn1,
    });

    const turn2 = metaTextPayload(
      'wamid.INJECT-TURN-2',
      from,
      MALICIOUS_PAYLOADS.promptInjectionRolePlay,
    );
    const response = await configuredApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(turn2) },
      payload: turn2,
    });
    expect(response.statusCode).toBe(200);

    const conversations = await configuredApp.ctx.prisma.conversation.findMany({
      where: { customerRef: from },
      include: { messages: { orderBy: { createdAt: 'asc' }, include: { intentRecords: true } } },
    });
    expect(conversations).toHaveLength(1);
    const secondMessage = conversations[0]?.messages[1];
    const flags = secondMessage?.intentRecords[0]?.flags as { promptInjectionDetected: boolean };
    expect(flags.promptInjectionDetected).toBe(true);
  });

  it('stays bounded and healthy under a flood of messages from the same customer in one conversation', async () => {
    const from = '971500000098';

    for (let i = 0; i < 30; i += 1) {
      const body = metaTextPayload(`wamid.FLOOD-${i}`, from, `message number ${i}`);
      const response = await configuredApp.app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
        payload: body,
      });
      expect(response.statusCode).toBe(200);
    }

    const conversations = await configuredApp.ctx.prisma.conversation.findMany({
      where: { customerRef: from },
      include: { messages: true },
    });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.messages).toHaveLength(30);
  });

  it('treats a SQL injection payload in the message body as inert text', async () => {
    const body = metaTextPayload(
      'wamid.sec-7',
      '971500000007',
      `I want a car ${MALICIOUS_PAYLOADS.sqlInjection}`,
    );
    const response = await configuredApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(await configuredApp.ctx.prisma.conversation.count()).toBe(1);
  });

  it('rejects malformed JSON with a 400, never a raw 500 crash', async () => {
    const garbage = '{not valid json';
    const response = await configuredApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(garbage) },
      payload: garbage,
    });
    expect(response.statusCode).toBe(400);
  });
});
