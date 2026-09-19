import { createHmac } from 'node:crypto';
import { createVehicle } from '@ai-concierge/db';
import { MissingInfoStatus } from '@ai-concierge/domain';
import { seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import { FakeWhatsAppProvider } from './test/fakeWhatsAppProvider.js';

const APP_SECRET = 'test-whatsapp-app-secret-0123456789';
const VERIFY_TOKEN = 'test-verify-token-abc';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body, 'utf8').digest('hex')}`;
}

function metaTextPayload(messageId: string, from: string, text: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '1234567890' },
              messages: [{ from, id: messageId, type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
}

describe('WhatsApp webhook — integration', () => {
  let testApp: TestApp;
  let fakeProvider: FakeWhatsAppProvider;

  beforeAll(async () => {
    fakeProvider = new FakeWhatsAppProvider();
    testApp = await buildTestApp(
      { WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN },
      { whatsappProvider: fakeProvider },
    );
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
    fakeProvider.sent.length = 0;
    await createVehicle(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
  });

  it('verifies the Meta webhook handshake and echoes the challenge', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=echo-me-123`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('echo-me-123');
  });

  it('runs Steps 1-4 automatically for a real WhatsApp message and replies with the deterministic result', async () => {
    const body = metaTextPayload(
      'wamid.demo-1',
      '971501234567',
      'Hi I want to rent a Lamborghini Urus 15-19 Oct, Dubai',
    );

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    const conversation = await testApp.ctx.prisma.conversation.findFirst({
      where: { customerRef: '971501234567' },
      include: {
        messages: {
          include: {
            intentRecords: true,
            dateLocationExtractions: true,
            vehicleDeterminations: true,
            missingInfoChecks: true,
          },
        },
      },
    });

    expect(conversation).not.toBeNull();
    expect(conversation!.channel).toBe('WHATSAPP');
    const message = conversation!.messages[0]!;
    expect(message.intentRecords).toHaveLength(1);
    expect(message.dateLocationExtractions).toHaveLength(1);
    expect(message.vehicleDeterminations).toHaveLength(1);
    expect(message.missingInfoChecks).toHaveLength(1);

    // The example message names a real fleet vehicle, real dates and a real
    // location, so Step 4 should find nothing missing.
    const missingInfoRow = message.missingInfoChecks[0]!;
    expect(missingInfoRow.status).toBe(MissingInfoStatus.COMPLETE);

    expect(fakeProvider.sent).toHaveLength(1);
    expect(fakeProvider.sent[0]!.to).toBe('971501234567');
    expect(fakeProvider.sent[0]!.body).toMatch(/Lamborghini Urus/);
  });

  it('asks a deterministic clarification question automatically when required info is missing', async () => {
    const body = metaTextPayload('wamid.demo-2', '971509999999', 'Hi I want to rent a car');

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    expect(response.statusCode).toBe(200);

    const missingInfoRow = await testApp.ctx.prisma.missingInfoCheck.findFirst({
      where: { message: { conversation: { customerRef: '971509999999' } } },
    });
    expect(missingInfoRow?.status).toBe(MissingInfoStatus.NEEDS_INFO);

    expect(fakeProvider.sent).toHaveLength(1);
    expect(fakeProvider.sent[0]!.body).toBe(missingInfoRow!.clarificationPrompt);
  });

  it('is idempotent for a redelivered Meta message id: no reprocessing, no second reply', async () => {
    const body = metaTextPayload(
      'wamid.demo-dup',
      '971500000000',
      'Hi I want to rent a car in Dubai',
    );
    const headers = { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) };

    const first = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers,
      payload: body,
    });
    const second = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers,
      payload: body,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const count = await testApp.ctx.prisma.conversation.count({
      where: { customerRef: '971500000000' },
    });
    expect(count).toBe(1);
    expect(fakeProvider.sent).toHaveLength(1);
  });

  it('is idempotent even when the same message id is redelivered truly concurrently', async () => {
    const body = metaTextPayload(
      'wamid.demo-concurrent',
      '971500000099',
      'Hi I want to rent a car in Dubai',
    );
    const headers = { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) };

    // Simulates Meta redelivering before the first delivery has finished the
    // multi-step pipeline + outbound send — the exact race a check-then-act
    // (find, then save at the end) idempotency guard would miss.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        testApp.app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers, payload: body }),
      ),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(200);
    }
    const count = await testApp.ctx.prisma.conversation.count({
      where: { customerRef: '971500000099' },
    });
    expect(count).toBe(1);
    expect(fakeProvider.sent).toHaveLength(1);
  });

  it('acks 200 and does nothing for a delivery-status callback (no messages array)', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [{ value: { statuses: [{ id: 'wamid.demo-3', status: 'delivered' }] } }],
        },
      ],
    });

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(await testApp.ctx.prisma.conversation.count()).toBe(0);
    expect(fakeProvider.sent).toHaveLength(0);
  });
});
