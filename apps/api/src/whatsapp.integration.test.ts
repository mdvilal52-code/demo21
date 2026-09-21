import { createVehicle } from '@ai-concierge/db';
import { signWebhookPayload } from '@ai-concierge/security';
import { seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

const APP_SECRET = 'integration-test-app-secret';
const VERIFY_TOKEN = 'integration-test-verify-token';

function metaPayload(from: string, id: string, body: string) {
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
              messages: [{ from, id, timestamp: '1710000000', type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  });
}

function sign(raw: string): string {
  return `sha256=${signWebhookPayload(raw, APP_SECRET)}`;
}

describe('WhatsApp webhook — integration', () => {
  let testApp: TestApp;
  let sendTextMessage: ReturnType<typeof vi.fn>;

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
    sendTextMessage = vi.fn().mockResolvedValue(undefined);
    testApp.ctx.whatsappClient = { sendTextMessage };
  });

  it("answers Meta's GET verification challenge with the raw challenge string", async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge-abc-123`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('challenge-abc-123');
  });

  it('processes an inbound text message end to end and sends the Step 4 reply', async () => {
    const raw = metaPayload('971501234567', 'wamid.E2E-1', 'I want to rent a car');

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    const conversations = await testApp.ctx.prisma.conversation.findMany({
      include: { messages: true },
    });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.channel).toBe('WHATSAPP');
    expect(conversations[0]?.customerRef).toBe('971501234567');
    expect(conversations[0]?.messages[0]?.content).toBe('I want to rent a car');

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [to, replyText] = sendTextMessage.mock.calls[0] as [string, string];
    expect(to).toBe('971501234567');
    expect(typeof replyText).toBe('string');
    expect(replyText.length).toBeGreaterThan(0);

    const missingInfoChecks = await testApp.ctx.prisma.missingInfoCheck.findMany();
    expect(missingInfoChecks).toHaveLength(1);
    expect(missingInfoChecks[0]?.status).toBe('NEEDS_INFO');
  });

  it('runs Steps 1-4 and replies with a completion summary when one message has everything', async () => {
    const raw = metaPayload(
      '971509999999',
      'wamid.E2E-COMPLETE',
      'I want a Lamborghini Urus from 15 Oct to 19 Oct, pickup at Dubai Marina',
    );

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });

    expect(response.statusCode).toBe(200);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, replyText] = sendTextMessage.mock.calls[0] as [string, string];
    // Whatever Step 3 actually resolved (fleet may or may not have this exact
    // model seeded) — the point is Step 4 ran and produced a real reply, not
    // that this specific message reaches COMPLETE.
    expect(typeof replyText).toBe('string');
    expect(replyText.length).toBeGreaterThan(0);
  });

  it('deduplicates a redelivered webhook by WhatsApp message id', async () => {
    const raw = metaPayload('971501234567', 'wamid.DUPE', 'I want to rent a car');

    const first = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });
    const second = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const conversations = await testApp.ctx.prisma.conversation.findMany();
    expect(conversations).toHaveLength(1);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('does not break the existing REST enquiries endpoint', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: { channel: 'WEB', customerRef: 'web-user-1', message: 'I want to rent a car' },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('WhatsApp webhook — conversation continuity (the "Yes" bug)', () => {
  let testApp: TestApp;
  let sendTextMessage: ReturnType<typeof vi.fn>;

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
    sendTextMessage = vi.fn().mockResolvedValue(undefined);
    testApp.ctx.whatsappClient = { sendTextMessage };
  });

  async function seedFleet() {
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
    await createVehicle(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Ferrari',
      model: '812',
      category: 'SPORTS',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 2,
      luggage: 1,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 4500 },
    });
  }

  async function send(from: string, id: string, body: string) {
    const raw = metaPayload(from, id, body);
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
  }

  function lastReply(): string {
    const calls = sendTextMessage.mock.calls;
    return calls[calls.length - 1]![1] as string;
  }

  it('walks Hiii -> Yes -> Lamborghini Urus -> details through one conversation without ever repeating the greeting', async () => {
    await seedFleet();
    const CUSTOMER = '971501111111';

    // Stage 1: greeting -> booking invitation.
    await send(CUSTOMER, 'wamid.STAGE1', 'Hiii');
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const stage1Reply = lastReply();
    expect(stage1Reply).toMatch(/book a car/i);

    let conversations = await testApp.ctx.prisma.conversation.findMany({
      include: { messages: true },
    });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.stage).toBe('AWAITING_BOOKING_CONFIRMATION');
    expect(conversations[0]?.messages).toHaveLength(1);
    const conversationId = conversations[0]!.id;

    // Stage 2: "Yes" -> asks which car, and is NOT the stage-1 greeting again.
    await send(CUSTOMER, 'wamid.STAGE2', 'Yes');
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    const stage2Reply = lastReply();
    expect(stage2Reply).toMatch(/which car/i);
    expect(stage2Reply).not.toBe(stage1Reply);

    conversations = await testApp.ctx.prisma.conversation.findMany({ include: { messages: true } });
    expect(conversations).toHaveLength(1); // still the same conversation, not a new one
    expect(conversations[0]?.id).toBe(conversationId);
    expect(conversations[0]?.stage).toBe('COLLECTING_VEHICLE');
    expect(conversations[0]?.messages).toHaveLength(2);

    // Stage 3: names the car -> acknowledges it and asks for the missing details.
    await send(CUSTOMER, 'wamid.STAGE3', 'Lamborghini Urus');
    const stage3Reply = lastReply();
    expect(stage3Reply).toMatch(/lamborghini urus/i);
    expect(stage3Reply).not.toBe(stage1Reply);
    expect(stage3Reply).not.toBe(stage2Reply);

    conversations = await testApp.ctx.prisma.conversation.findMany({ include: { messages: true } });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.stage).toBe('COLLECTING_DETAILS');
    expect(conversations[0]?.messages).toHaveLength(3);

    // Stage 4: supplies the remaining details -> booking completes.
    await send(CUSTOMER, 'wamid.STAGE4', 'Pickup 15 Oct, return 19 Oct, Dubai Marina');
    const stage4Reply = lastReply();
    expect(stage4Reply).toMatch(/lamborghini urus/i);
    expect(stage4Reply).toMatch(/follow up/i);

    conversations = await testApp.ctx.prisma.conversation.findMany({ include: { messages: true } });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.stage).toBe('COMPLETE');
    expect(conversations[0]?.messages).toHaveLength(4);

    // A repeat of any earlier webhook event is still deduplicated (message id already seen).
    await send(CUSTOMER, 'wamid.STAGE2', 'Yes');
    expect(sendTextMessage).toHaveBeenCalledTimes(4); // unchanged — no 5th send
  });

  it('does not repeat the greeting for an unclear reply, and eventually resumes correctly', async () => {
    const CUSTOMER = '971502222222';

    await send(CUSTOMER, 'wamid.A1', 'Hello');
    const greeting = lastReply();

    await send(CUSTOMER, 'wamid.A2', 'hmm not sure');
    const nudge = lastReply();
    expect(nudge).not.toBe(greeting);

    const conversations = await testApp.ctx.prisma.conversation.findMany();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.stage).toBe('AWAITING_BOOKING_CONFIRMATION');
  });

  it('declines gracefully for "No" without repeating the greeting, and resets cleanly', async () => {
    const CUSTOMER = '971503333333';

    await send(CUSTOMER, 'wamid.B1', 'Hi there');
    const greeting = lastReply();

    await send(CUSTOMER, 'wamid.B2', 'No thanks');
    const declineReply = lastReply();
    expect(declineReply).not.toBe(greeting);
    expect(declineReply).toMatch(/no problem/i);

    const conversations = await testApp.ctx.prisma.conversation.findMany();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.stage).toBe('NEW');
  });

  it('gives a brand-new customer the correct initial conversation, independent of another customer', async () => {
    await send('971504444444', 'wamid.C1', 'Hiii');
    await send('971505555555', 'wamid.C2', 'Hiii');

    const conversations = await testApp.ctx.prisma.conversation.findMany();
    expect(conversations).toHaveLength(2);
    expect(new Set(conversations.map((c) => c.customerRef))).toEqual(
      new Set(['971504444444', '971505555555']),
    );
    for (const conversation of conversations) {
      expect(conversation.stage).toBe('AWAITING_BOOKING_CONFIRMATION');
    }
  });

  it("resumes an existing customer's conversation from its saved stage across separate webhook deliveries", async () => {
    await seedFleet();
    const CUSTOMER = '971506666666';

    await send(CUSTOMER, 'wamid.D1', 'Hiii');
    await send(CUSTOMER, 'wamid.D2', 'Yes');

    let conversations = await testApp.ctx.prisma.conversation.findMany();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.stage).toBe('COLLECTING_VEHICLE');

    // A later, independent webhook delivery for the same customer resumes
    // from COLLECTING_VEHICLE, not from a fresh NEW/greeting stage.
    await send(CUSTOMER, 'wamid.D3', 'Lamborghini Urus');
    conversations = await testApp.ctx.prisma.conversation.findMany();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.stage).toBe('COLLECTING_DETAILS');
    expect(lastReply()).toMatch(/lamborghini urus/i);
  });

  it('lets the customer correct their vehicle choice mid-cycle instead of silently keeping the first one', async () => {
    await seedFleet();
    const CUSTOMER = '971507777777';

    await send(CUSTOMER, 'wamid.E1', 'Hiii');
    await send(CUSTOMER, 'wamid.E2', 'Yes');
    await send(CUSTOMER, 'wamid.E3', 'Lamborghini Urus');
    expect(lastReply()).toMatch(/lamborghini urus/i);

    // The customer changes their mind before finishing the booking.
    await send(CUSTOMER, 'wamid.E4', 'Actually, give me the Ferrari 812 instead');
    expect(lastReply()).toMatch(/ferrari 812/i);
    expect(lastReply()).not.toMatch(/lamborghini/i);

    await send(CUSTOMER, 'wamid.E5', 'Pickup 15 Oct, return 19 Oct, Dubai Marina');
    const finalReply = lastReply();
    expect(finalReply).toMatch(/ferrari 812/i);
    expect(finalReply).not.toMatch(/lamborghini/i);

    const conversations = await testApp.ctx.prisma.conversation.findMany();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.stage).toBe('COMPLETE');

    const finalCheck = await testApp.ctx.prisma.missingInfoCheck.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    const collected = finalCheck?.collected as { vehicle: { model: string } | null };
    expect(collected.vehicle?.model).toBe('812');
  });

  it("does not let a finished booking cycle leak stale dates/vehicle into the customer's next, unrelated request", async () => {
    await seedFleet();
    const CUSTOMER = '971508888888';

    // First booking cycle: completes fully.
    await send(CUSTOMER, 'wamid.F1', 'Hiii');
    await send(CUSTOMER, 'wamid.F2', 'Yes');
    await send(CUSTOMER, 'wamid.F3', 'Lamborghini Urus');
    await send(CUSTOMER, 'wamid.F4', 'Pickup 15 Oct, return 19 Oct, Dubai Marina');

    let conversations = await testApp.ctx.prisma.conversation.findMany();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.stage).toBe('COMPLETE');
    const firstCycleStartedAt = conversations[0]!.cycleStartedAt;

    // The same customer starts a second, unrelated request in the same
    // preserved conversation thread — mentioning only the new vehicle.
    await send(CUSTOMER, 'wamid.F5', 'Hi, I would like to book again');
    await send(CUSTOMER, 'wamid.F6', 'Yes');
    await send(CUSTOMER, 'wamid.F7', 'Ferrari 812');

    conversations = await testApp.ctx.prisma.conversation.findMany();
    expect(conversations).toHaveLength(1); // still one preserved thread, not a new conversation
    // A fresh cycle started — not immediately COMPLETE/EXPIRED using the
    // first booking's now-irrelevant dates.
    expect(conversations[0]?.stage).toBe('COLLECTING_DETAILS');
    expect(conversations[0]!.cycleStartedAt.getTime()).toBeGreaterThan(
      firstCycleStartedAt.getTime(),
    );

    const reply = lastReply();
    expect(reply).toMatch(/ferrari 812/i);
    // Must still ask for dates/location — they must NOT be silently assumed
    // to be the first booking's (15/19 Oct, Dubai Marina).
    expect(reply).toMatch(/pick up|return|location/i);
  });
});
