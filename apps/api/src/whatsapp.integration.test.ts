import { createHmac } from 'node:crypto';
import { createMissingInfoCheck, createVehicle } from '@ai-concierge/db';
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

  it('carries context across turns instead of restarting the conversation from scratch', async () => {
    const from = '971507000001';

    const turn1 = metaTextPayload('wamid.MULTI-TURN-1', from, 'I want to rent a Lamborghini Urus');
    const firstResponse = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(turn1) },
      payload: turn1,
    });
    expect(firstResponse.statusCode).toBe(200);
    expect(fakeProvider.sent).toHaveLength(1);
    const firstReply = fakeProvider.sent[0]!.body;
    // Turn 1 alone has a vehicle but no dates/location — Step 4 must still be
    // asking for something, not the generic non-booking fallback.
    expect(firstReply).not.toMatch(/let us know if you'd like to book a car/i);

    // Turn 2, alone, has no booking/vehicle keyword at all (only dates and a
    // location) — before this fix this independently classified as a
    // non-booking message and got the same generic fallback reply every
    // time, regardless of what turn 1 already established. This is the
    // exact bug reported against the live number.
    const turn2 = metaTextPayload(
      'wamid.MULTI-TURN-2',
      from,
      'from 15 Oct to 19 Oct, pickup at Dubai Marina',
    );
    const secondResponse = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(turn2) },
      payload: turn2,
    });
    expect(secondResponse.statusCode).toBe(200);

    // Both messages landed in the same conversation — no thread was lost.
    const conversations = await testApp.ctx.prisma.conversation.findMany({
      where: { customerRef: from },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.messages).toHaveLength(2);

    // Turn 2's reply reflects the *merged* context (vehicle from turn 1 +
    // dates/location from turn 2), reaching COMPLETE since the fleet has a
    // real Lamborghini Urus seeded — not a repeat of turn 1's question and
    // not the generic non-booking fallback.
    expect(fakeProvider.sent).toHaveLength(2);
    const secondReply = fakeProvider.sent[1]!.body;
    expect(secondReply).not.toBe(firstReply);
    expect(secondReply).not.toMatch(/let us know if you'd like to book a car/i);

    const missingInfoChecks = await testApp.ctx.prisma.missingInfoCheck.findMany({
      where: { message: { conversationId: conversations[0]?.id } },
      orderBy: { createdAt: 'asc' },
    });
    expect(missingInfoChecks).toHaveLength(2);
    expect(missingInfoChecks[0]?.status).toBe(MissingInfoStatus.NEEDS_INFO);
    expect(missingInfoChecks[1]?.status).toBe(MissingInfoStatus.COMPLETE);
    expect(secondReply).toMatch(/Lamborghini Urus/);
  });

  it('starts a new conversation for a different customer instead of merging threads', async () => {
    const turnA = metaTextPayload('wamid.ISOLATION-A', '971507000002', 'I want to rent a car');
    const turnB = metaTextPayload('wamid.ISOLATION-B', '971507000003', 'I want to rent a car');

    await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(turnA) },
      payload: turnA,
    });
    await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(turnB) },
      payload: turnB,
    });

    const conversations = await testApp.ctx.prisma.conversation.findMany({
      where: { customerRef: { in: ['971507000002', '971507000003'] } },
    });
    expect(conversations).toHaveLength(2);
  });

  it('starts a new conversation once the previous one completed, for the same customer', async () => {
    const from = '971507000004';
    const firstTurn = metaTextPayload('wamid.RESTART-1', from, 'I want to rent a car');
    await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(firstTurn) },
      payload: firstTurn,
    });

    const afterFirst = await testApp.ctx.prisma.conversation.findMany({
      where: { customerRef: from },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    expect(afterFirst).toHaveLength(1);
    const latestMessage = afterFirst[0]?.messages[0];
    expect(latestMessage).toBeDefined();

    // Force this conversation's Step 4 outcome to COMPLETE directly — the
    // point of this test is proving the open-conversation lookup's wiring
    // through the real webhook, not depending on extraction accuracy (see
    // the "carries context across turns" test above for that).
    await createMissingInfoCheck(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: latestMessage!.id,
      result: {
        status: MissingInfoStatus.COMPLETE,
        collected: {
          pickupDate: '2026-10-15T06:00:00.000Z',
          returnDate: '2026-10-19T06:00:00.000Z',
          pickupLocation: null,
          dropoffLocation: null,
          vehicle: null,
        },
        missingFields: [],
        clarificationPrompt: null,
        expiresAt: '2026-10-16T00:00:00.000Z',
        flags: { promptInjectionDetectedAnywhere: false },
        modelMetadata: {
          engine: 'missing-info-evaluator-v1',
          version: '0.1.0',
          deterministic: true,
        },
      },
    });

    const followUp = metaTextPayload('wamid.RESTART-2', from, 'Hi, I need another car please');
    await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(followUp) },
      payload: followUp,
    });

    const afterSecond = await testApp.ctx.prisma.conversation.findMany({
      where: { customerRef: from },
    });
    expect(afterSecond).toHaveLength(2);
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
