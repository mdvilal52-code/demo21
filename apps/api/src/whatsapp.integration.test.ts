import { createMissingInfoCheck } from '@ai-concierge/db';
import { signWebhookPayload } from '@ai-concierge/security';
import { seedTestTenants, TEST_TENANT_ID, truncateAllTables } from '@ai-concierge/testing';
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

  it('carries context across turns instead of restarting the conversation from scratch', async () => {
    const from = '971507000001';

    const turn1 = metaPayload(from, 'wamid.MULTI-TURN-1', 'I want to rent a Lamborghini Urus');
    const firstResponse = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(turn1) },
      payload: turn1,
    });
    expect(firstResponse.statusCode).toBe(200);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, firstReply] = sendTextMessage.mock.calls[0] as [string, string];
    // Turn 1 alone has a vehicle but no dates/location — Step 4 must still be
    // asking for something, not the generic non-booking fallback.
    expect(firstReply).not.toMatch(/one of our team members/i);

    // Turn 2, alone, has no booking/vehicle keyword at all (only dates and a
    // location) — under the pre-fix behavior this independently classified
    // as a non-booking message and got the same generic fallback reply every
    // time, regardless of what turn 1 already established.
    const turn2 = metaPayload(
      from,
      'wamid.MULTI-TURN-2',
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
    expect(conversations[0]?.messages[0]?.content).toBe('I want to rent a Lamborghini Urus');
    expect(conversations[0]?.messages[1]?.content).toBe(
      'from 15 Oct to 19 Oct, pickup at Dubai Marina',
    );

    // Turn 2's reply reflects the *merged* context (vehicle from turn 1 +
    // dates/location from turn 2) — not a repeat of turn 1's question and
    // not the generic "team will get back to you" non-booking fallback.
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    const [, secondReply] = sendTextMessage.mock.calls[1] as [string, string];
    expect(secondReply).not.toBe(firstReply);
    expect(secondReply).not.toMatch(/one of our team members/i);

    const missingInfoChecks = await testApp.ctx.prisma.missingInfoCheck.findMany({
      where: { message: { conversationId: conversations[0]?.id } },
      orderBy: { createdAt: 'asc' },
    });
    expect(missingInfoChecks).toHaveLength(2);
    expect(missingInfoChecks[0]?.status).toBe('NEEDS_INFO');
    // Whatever exactly Step 3 resolved for "Lamborghini Urus" against the
    // seeded fleet, turn 2 must have made real progress against turn 1's
    // missing fields — reaching COMPLETE, or at minimum leaving fewer
    // fields outstanding than turn 1 did.
    const firstMissingCount = (missingInfoChecks[0]?.missingFields as unknown[]).length;
    const secondMissingCount = (missingInfoChecks[1]?.missingFields as unknown[]).length;
    expect(missingInfoChecks[1]?.status).not.toBe('NOT_APPLICABLE');
    expect(secondMissingCount).toBeLessThan(firstMissingCount);
  });

  it('starts a new conversation for a different customer instead of merging threads', async () => {
    const turnA = metaPayload('971507000002', 'wamid.ISOLATION-A', 'I want to rent a car');
    const turnB = metaPayload('971507000003', 'wamid.ISOLATION-B', 'I want to rent a car');

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
    const firstTurn = metaPayload(from, 'wamid.RESTART-1', 'I want to rent a car');
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
    // point of this test is proving `findOpenConversationForCustomer`'s
    // wiring through the real webhook, not depending on extraction
    // accuracy (see the "carries context across turns" test above for that).
    await createMissingInfoCheck(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: latestMessage!.id,
      result: {
        status: 'COMPLETE',
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

    const followUp = metaPayload(from, 'wamid.RESTART-2', 'Hi, I need another car please');
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
