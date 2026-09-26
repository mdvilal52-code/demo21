import { randomUUID } from 'node:crypto';
import { createEligibilityPolicyVersion, createVehicle, createVehicleUnit } from '@ai-concierge/db';
import type { EligibilityPolicyRules } from '@ai-concierge/domain';
import {
  seedTestTenants,
  seedTestUser,
  truncateAllTables,
  TEST_TENANT_ID,
  TEST_USER_PASSWORD,
} from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import { FakeNotificationProvider } from './test/fakeNotificationProvider.js';
import { FakeWhatsAppProvider } from './test/fakeWhatsAppProvider.js';

/**
 * The public web chat and the admin dashboard's new surfaces (summary, quotes,
 * transcript, human reply), through the real HTTP layer and a real Postgres.
 * The chat drives the same automatic Steps 1-8 chain as WhatsApp/Email, so
 * these tests double as proof that a customer can go from "hello" to an issued
 * quote — and to a person — from the website alone.
 */
const POLICY: EligibilityPolicyRules = {
  minAge: 21,
  minAgeByLuxuryTier: { ULTRA_LUXURY: 25 },
  requiredLicenseTypes: ['UAE', 'GCC', 'IDP'],
  passportRequired: true,
  nationalityRules: { blockedNationalities: [], allowedNationalitiesOnly: [] },
  vehicleRestrictions: {},
  restrictedCities: [],
  driverRequirements: {
    maxAdditionalDrivers: 2,
    additionalDriverMinAge: 21,
    additionalDriversRequireValidLicense: true,
  },
};
const BOOKING =
  'Hi, I would like to rent a Lamborghini Urus from 15 October to 19 October, pickup Dubai Marina';
const FULL_DETAILS =
  "I'm Indian, born 12 May 1990, I hold a UAE driving licence and I can provide my passport";

describe('web chat + dashboard surfaces — integration', () => {
  let testApp: TestApp;
  let whatsapp: FakeWhatsAppProvider;

  beforeAll(async () => {
    whatsapp = new FakeWhatsAppProvider();
    testApp = await buildTestApp(
      { RATE_LIMIT_MAX: 5000, AUTH_RATE_LIMIT_MAX: 5000 },
      { whatsappProvider: whatsapp, notificationProvider: new FakeNotificationProvider() },
    );
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
    whatsapp.sent.length = 0;
    const urus = await createVehicle(testApp.ctx.prisma, {
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
    await createVehicleUnit(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      vehicleId: urus.id,
      unitRef: 'URUS-0',
    });
    await createEligibilityPolicyVersion(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      rules: POLICY,
    });
  });

  async function chat(sessionId: string, message: string, clientMessageId = randomUUID()) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/chat/messages',
      payload: { sessionId, clientMessageId, message },
    });
    return { status: response.statusCode, body: response.json(), clientMessageId };
  }

  async function chatSession(sessionId: string) {
    const response = await testApp.app.inject({
      method: 'GET',
      url: `/v1/chat/sessions/${sessionId}`,
    });
    return { status: response.statusCode, body: response.json() };
  }

  async function staffToken(role: 'OPS_AGENT' | 'ADMIN' = 'OPS_AGENT') {
    const email = `${role.toLowerCase()}@example.com`;
    const existing = await testApp.ctx.prisma.user.findFirst({ where: { email } });
    if (!existing)
      await seedTestUser(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, role, email });
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: TEST_USER_PASSWORD },
    });
    return response.json().accessToken as string;
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  describe('customer web chat', () => {
    it(
      'takes a visitor from "hello" to an issued quote with nothing but the chat',
      { timeout: 120_000 },
      async () => {
        const sessionId = randomUUID();

        const first = await chat(sessionId, BOOKING);
        expect(first.status).toBe(200);
        expect(first.body.reply.text).toMatch(/date of birth/i);
        expect(first.body.journeyState).toBe('ELIGIBILITY_CHECK');
        expect(first.body.booking).toMatchObject({
          vehicle: 'Lamborghini Urus',
          pickupLocation: expect.stringMatching(/Dubai/),
        });
        expect(first.body.quote).toBeNull();
        expect(first.body.escalated).toBe(false);

        const second = await chat(sessionId, FULL_DETAILS);
        expect(second.status).toBe(200);
        expect(second.body.journeyState).toBe('QUOTE_ISSUED');
        expect(second.body.reply.text).toMatch(/Total: AED/);
        expect(second.body.quote).toMatchObject({ currency: 'AED', status: 'ISSUED' });
        expect(second.body.quote.total.minorUnits).toBeGreaterThan(0);
        // Customer-facing quote: every price line, nothing internal.
        expect(JSON.stringify(second.body)).not.toMatch(
          /integrityHash|reviewReasons|modelMetadata/,
        );

        const session = await chatSession(sessionId);
        expect(session.status).toBe(200);
        expect(session.body.messages.map((m: { role: string }) => m.role)).toEqual([
          'CUSTOMER',
          'CONCIERGE',
          'CUSTOMER',
          'CONCIERGE',
        ]);
        expect(session.body.quote.quoteId).toBe(second.body.quote.quoteId);
        expect(session.body.journeyState).toBe('QUOTE_ISSUED');
      },
    );

    it(
      'replays a retried message instead of running the pipeline twice',
      { timeout: 60_000 },
      async () => {
        const sessionId = randomUUID();
        const clientMessageId = randomUUID();
        const first = await chat(sessionId, BOOKING, clientMessageId);
        const retry = await chat(sessionId, BOOKING, clientMessageId);
        expect(retry.status).toBe(200);
        expect(retry.body.reply.id).toBe(first.body.reply.id);
        expect(await testApp.ctx.prisma.message.count()).toBe(1);
        expect(await testApp.ctx.prisma.outboundMessage.count()).toBe(1);
      },
    );

    it("keeps one visitor's chat invisible to another", { timeout: 60_000 }, async () => {
      await chat(randomUUID(), BOOKING);
      const stranger = await chatSession(randomUUID());
      expect(stranger.status).toBe(200);
      expect(stranger.body.messages).toEqual([]);
      expect(stranger.body.conversationId).toBeNull();
    });

    it.each([
      [
        'a session id that is not a UUID',
        { sessionId: 'abc', clientMessageId: randomUUID(), message: 'hi' },
      ],
      [
        'an empty message',
        { sessionId: randomUUID(), clientMessageId: randomUUID(), message: '   ' },
      ],
      [
        'a message over 1000 characters',
        { sessionId: randomUUID(), clientMessageId: randomUUID(), message: 'x'.repeat(1001) },
      ],
      [
        'an unknown extra field',
        { sessionId: randomUUID(), clientMessageId: randomUUID(), message: 'hi', role: 'STAFF' },
      ],
      ['a missing clientMessageId', { sessionId: randomUUID(), message: 'hi' }],
    ])('rejects %s', async (_label, payload) => {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/v1/chat/messages',
        payload,
      });
      expect(response.statusCode).toBe(400);
    });

    it('rate-limits one session without affecting another', { timeout: 60_000 }, async () => {
      const limited = await buildTestApp({
        CHAT_SESSION_LIMIT_PER_10_MIN: 2,
        RATE_LIMIT_MAX: 5000,
      });
      try {
        const send = (sessionId: string) =>
          limited.app.inject({
            method: 'POST',
            url: '/v1/chat/messages',
            payload: { sessionId, clientMessageId: randomUUID(), message: 'Hi' },
          });
        const noisy = randomUUID();
        expect((await send(noisy)).statusCode).toBe(200);
        expect((await send(noisy)).statusCode).toBe(200);
        const blocked = await send(noisy);
        expect(blocked.statusCode).toBe(429);
        expect(blocked.json().error.code).toBe('RATE_LIMITED');
        expect((await send(randomUUID())).statusCode).toBe(200);
      } finally {
        await limited.close();
      }
    });
  });

  describe('human worker', () => {
    async function escalatedWebChat() {
      const sessionId = randomUUID();
      await chat(sessionId, BOOKING);
      const handoff = await chat(sessionId, 'Actually I want to speak to a human agent please');
      expect(handoff.body.escalated).toBe(true);
      return { sessionId, conversationId: handoff.body.conversationId as string };
    }

    it('requires a signed-in staff member for every dashboard route', async () => {
      const conversationId = randomUUID();
      for (const [method, url] of [
        ['GET', '/v1/dashboard/summary'],
        ['GET', '/v1/quotes'],
        ['GET', `/v1/enquiries/${conversationId}/transcript`],
        ['POST', `/v1/enquiries/${conversationId}/staff-reply`],
      ] as const) {
        const response = await testApp.app.inject({
          method,
          url,
          ...(method === 'POST' ? { payload: { message: 'hi' } } : {}),
        });
        expect(response.statusCode, `${method} ${url}`).toBe(401);
      }
    });

    it(
      'lets a person read the conversation and answer an escalated web customer',
      { timeout: 120_000 },
      async () => {
        const { sessionId, conversationId } = await escalatedWebChat();
        const token = await staffToken();

        const transcript = await testApp.app.inject({
          method: 'GET',
          url: `/v1/enquiries/${conversationId}/transcript`,
          headers: auth(token),
        });
        expect(transcript.statusCode).toBe(200);
        const thread = transcript.json();
        expect(thread.conversation).toMatchObject({ id: conversationId, channel: 'WEB' });
        expect(thread.messages.map((m: { role: string }) => m.role)).toEqual([
          'CUSTOMER',
          'CONCIERGE',
          'CUSTOMER',
          'CONCIERGE',
        ]);
        expect(thread.messages.at(-1).content).toMatch(/team/i);

        const reply = await testApp.app.inject({
          method: 'POST',
          url: `/v1/enquiries/${conversationId}/staff-reply`,
          headers: auth(token),
          payload: { message: 'Hello, this is Sam from the team. How can I help?' },
        });
        expect(reply.statusCode).toBe(200);
        expect(reply.json()).toMatchObject({
          delivered: true,
          delivery: 'STORED',
          message: { role: 'STAFF', content: 'Hello, this is Sam from the team. How can I help?' },
        });

        // The customer's chat now shows the person's words, marked as staff.
        const session = await chatSession(sessionId);
        expect(session.body.messages.at(-1)).toMatchObject({
          role: 'STAFF',
          content: 'Hello, this is Sam from the team. How can I help?',
        });

        // Attributed and audited, without the audit trail holding the message text.
        const stored = await testApp.ctx.prisma.outboundMessage.findFirst({
          where: { source: 'HUMAN' },
        });
        expect(stored?.authorUserId).toBeTruthy();
        const audit = await testApp.ctx.prisma.auditEvent.findFirst({
          where: { action: 'conversation.staff_reply' },
        });
        expect(audit).not.toBeNull();
        expect(JSON.stringify(audit)).not.toContain('Sam from the team');
      },
    );

    it('rejects an empty or oversized staff reply and an unknown conversation', async () => {
      const token = await staffToken();
      const conversationId = randomUUID();
      const post = (payload: unknown, id = conversationId) =>
        testApp.app.inject({
          method: 'POST',
          url: `/v1/enquiries/${id}/staff-reply`,
          headers: auth(token),
          payload: payload as never,
        });
      expect((await post({ message: '   ' })).statusCode).toBe(400);
      expect((await post({ message: 'x'.repeat(1001) })).statusCode).toBe(400);
      expect((await post({ message: 'hi', extra: true })).statusCode).toBe(400);
      expect((await post({ message: 'hello' })).statusCode).toBe(404);
    });

    it("sends a reply over WhatsApp when that is the customer's channel", async () => {
      const conversation = await testApp.ctx.prisma.conversation.create({
        data: { tenantId: TEST_TENANT_ID, channel: 'WHATSAPP', customerRef: '971500000123' },
      });
      const token = await staffToken();
      const reply = await testApp.app.inject({
        method: 'POST',
        url: `/v1/enquiries/${conversation.id}/staff-reply`,
        headers: auth(token),
        payload: { message: 'We have your request and will call you shortly.' },
      });
      expect(reply.json()).toMatchObject({ delivered: true, delivery: 'SENT' });
      expect(whatsapp.sent).toEqual([
        { to: '971500000123', body: 'We have your request and will call you shortly.' },
      ]);
    });

    it('never records a reply the customer did not receive (channel not configured)', async () => {
      const conversation = await testApp.ctx.prisma.conversation.create({
        data: { tenantId: TEST_TENANT_ID, channel: 'EMAIL', customerRef: 'guest@example.com' },
      });
      const token = await staffToken();
      const reply = await testApp.app.inject({
        method: 'POST',
        url: `/v1/enquiries/${conversation.id}/staff-reply`,
        headers: auth(token),
        payload: { message: 'Following up on your enquiry.' },
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({
        delivered: false,
        delivery: 'NOT_CONFIGURED',
        message: null,
      });
      expect(await testApp.ctx.prisma.outboundMessage.count()).toBe(0);
    });

    it('refuses to reply into a conversation whose journey has ended', async () => {
      const conversation = await testApp.ctx.prisma.conversation.create({
        data: { tenantId: TEST_TENANT_ID, channel: 'WEB', customerRef: 'web:ended' },
      });
      await testApp.ctx.prisma.journey.create({
        data: {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          state: 'CANCELLED',
          context: {
            conversationId: conversation.id,
            latestMessageId: null,
            resolvedVehicleId: null,
            quoteId: null,
            missingInfoAttempts: 0,
          },
        },
      });
      const token = await staffToken();
      const reply = await testApp.app.inject({
        method: 'POST',
        url: `/v1/enquiries/${conversation.id}/staff-reply`,
        headers: auth(token),
        payload: { message: 'Hello?' },
      });
      expect(reply.statusCode).toBe(409);
    });

    it(
      'shows what the customer said about themselves without exposing the date of birth',
      { timeout: 120_000 },
      async () => {
        const sessionId = randomUUID();
        await chat(sessionId, BOOKING);
        const done = await chat(sessionId, FULL_DETAILS);
        const token = await staffToken();
        const transcript = await testApp.app.inject({
          method: 'GET',
          url: `/v1/enquiries/${done.body.conversationId}/transcript`,
          headers: auth(token),
        });
        const thread = transcript.json();
        expect(thread.driverDetails).toEqual({
          nationality: 'IN',
          licenseType: 'UAE',
          hasValidLicense: true,
          passportProvided: true,
          dateOfBirthProvided: true,
        });
        expect(thread.eligibility).toMatchObject({ status: 'ELIGIBLE' });
        expect(thread.quote.status).toBe('ISSUED');
        // The customer's own message text contains the birth date, but no derived/structured field does.
        const { messages, ...rest } = thread;
        expect(messages.length).toBeGreaterThan(0);
        expect(JSON.stringify(rest)).not.toContain('1990');
      },
    );
  });

  describe('dashboard summary + quotes', () => {
    it(
      'reports live numbers from real journeys, escalations and quotes',
      { timeout: 180_000 },
      async () => {
        const buyer = randomUUID();
        await chat(buyer, BOOKING);
        await chat(buyer, FULL_DETAILS);
        const asker = randomUUID();
        await chat(asker, BOOKING);
        await chat(asker, 'I need to speak to a human');

        const token = await staffToken();
        const summary = await testApp.app.inject({
          method: 'GET',
          url: '/v1/dashboard/summary',
          headers: auth(token),
        });
        expect(summary.statusCode).toBe(200);
        const data = summary.json();
        expect(data.journeys.total).toBe(2);
        expect(data.journeys.active).toBe(2);
        expect(data.journeys.byState).toEqual(
          expect.arrayContaining([
            { state: 'QUOTE_ISSUED', count: 1 },
            { state: 'ESCALATED', count: 1 },
          ]),
        );
        expect(data.escalations).toMatchObject({ open: 1, inProgress: 0 });
        expect(data.automation).toMatchObject({
          journeys: 2,
          escalatedJourneys: 1,
          percentAutomated: 50,
        });
        expect(data.quotes.issued).toBe(1);
        expect(data.quotes.quotedValue).toEqual([
          { currency: 'AED', minorUnits: expect.any(Number) },
        ]);
        expect(data.quotes.quotedValue[0].minorUnits).toBeGreaterThan(0);
        expect(data.customers.total).toBeGreaterThanOrEqual(1);

        const quotes = await testApp.app.inject({
          method: 'GET',
          url: '/v1/quotes',
          headers: auth(token),
        });
        expect(quotes.statusCode).toBe(200);
        const list = quotes.json().items;
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
          vehicleName: 'Lamborghini Urus',
          channel: 'WEB',
          status: 'ISSUED',
          currency: 'AED',
        });
        expect(list[0].customerRef).toMatch(/^web:/);
      },
    );

    it('returns honest zeros (and no automation percentage) on an empty system', async () => {
      const token = await staffToken();
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/v1/dashboard/summary',
        headers: auth(token),
      });
      const data = response.json();
      expect(data.journeys).toEqual({ total: 0, active: 0, byState: [] });
      expect(data.automation.percentAutomated).toBeNull();
      expect(data.quotes).toEqual({ issued: 0, pendingReview: 0, quotedValue: [] });
    });
  });
});
