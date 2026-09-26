import { createHmac } from 'node:crypto';
import { createEligibilityPolicyVersion, createVehicle, createVehicleUnit } from '@ai-concierge/db';
import type { EligibilityPolicyRules } from '@ai-concierge/domain';
import { seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import { FakeWhatsAppProvider } from './test/fakeWhatsAppProvider.js';

/**
 * The whole automatic Steps 1-8 chain, driven the way a real customer drives
 * it: WhatsApp messages in through the signed Meta webhook, replies out
 * through the (fake) provider, a real Postgres underneath. Nothing here calls
 * a step's REST endpoint — every Step 5-8 transition must happen by itself.
 */
const APP_SECRET = 'test-whatsapp-app-secret-0123456789';

const DEFAULT_POLICY: EligibilityPolicyRules = {
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

/** Mirrors how replies print a total: whole amounts bare, cents as exactly two digits. */
function formatTotal(minorUnits: number): string {
  const digits = minorUnits % 100 === 0 ? 0 : 2;
  return (minorUnits / 100).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

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

describe('automatic Steps 5-8 chain — integration', () => {
  let testApp: TestApp;
  let whatsapp: FakeWhatsAppProvider;
  let seq = 0;

  beforeAll(async () => {
    whatsapp = new FakeWhatsAppProvider();
    testApp = await buildTestApp(
      { WHATSAPP_APP_SECRET: APP_SECRET },
      { whatsappProvider: whatsapp },
    );
  });

  afterAll(async () => {
    await testApp.close();
  });

  async function seedFleet(options: { urusUnits: number } = { urusUnits: 2 }) {
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
    const rangeRover = await createVehicle(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Land Rover',
      model: 'Range Rover',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      seats: 5,
      luggage: 5,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 1800 },
    });
    for (let i = 0; i < options.urusUnits; i += 1) {
      await createVehicleUnit(testApp.ctx.prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: urus.id,
        unitRef: `URUS-${i}`,
      });
    }
    for (let i = 0; i < 2; i += 1) {
      await createVehicleUnit(testApp.ctx.prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: rangeRover.id,
        unitRef: `RR-${i}`,
      });
    }
  }

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
    whatsapp.sent.length = 0;
  });

  async function seedPolicy() {
    await createEligibilityPolicyVersion(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      rules: DEFAULT_POLICY,
    });
  }

  /** One inbound customer message; returns the reply the customer received. */
  async function say(from: string, text: string): Promise<string> {
    seq += 1;
    const before = whatsapp.sent.length;
    const body = metaTextPayload(`wamid.AUTO-${seq}`, from, text);
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(whatsapp.sent.length).toBe(before + 1);
    return whatsapp.sent[whatsapp.sent.length - 1]!.body;
  }

  async function journeyFor(from: string) {
    const conversation = await testApp.ctx.prisma.conversation.findFirst({
      where: { customerRef: from },
      orderBy: { createdAt: 'desc' },
      include: { journey: true },
    });
    return { conversation, journey: conversation?.journey ?? null };
  }

  it(
    'takes a customer from first message to an issued quote with no manual step',
    { timeout: 120_000 },
    async () => {
      await seedFleet();
      await seedPolicy();
      const from = '971501110001';

      const askReply = await say(from, BOOKING);
      expect(askReply).toMatch(/Lamborghini Urus/);
      expect(askReply).toMatch(/date of birth/i);
      expect(askReply).toMatch(/nationality/i);
      expect((await journeyFor(from)).journey?.state).toBe('ELIGIBILITY_CHECK');

      const quoteReply = await say(from, FULL_DETAILS);
      expect(quoteReply).toMatch(/available/i);
      expect(quoteReply).toMatch(/Total: AED/);
      expect(quoteReply).toMatch(/Security deposit: AED/);
      expect(quoteReply).not.toMatch(/confirmed|booked/i);

      const { conversation, journey } = await journeyFor(from);
      expect(journey?.state).toBe('QUOTE_ISSUED');

      // Every step really ran and persisted through its own service.
      const prisma = testApp.ctx.prisma;
      const decision = await prisma.eligibilityDecision.findFirst({
        where: { message: { conversationId: conversation!.id } },
      });
      expect(decision?.status).toBe('ELIGIBLE');
      const hold = await prisma.availabilityHold.findFirst({ where: { status: 'ACTIVE' } });
      expect(hold).not.toBeNull();
      const quote = await prisma.quote.findFirst({ where: { conversationId: conversation!.id } });
      expect(quote?.status).toBe('ISSUED');
      const totalMinor = (quote!.total as { minorUnits: number }).minorUnits;
      const total = formatTotal(totalMinor);
      expect(quoteReply).toContain(`Total: AED ${total}`);

      // The customer's date of birth is stored encrypted, never in the clear.
      const intake = await prisma.eligibilityIntake.findFirst({
        where: { conversationId: conversation!.id },
      });
      expect(intake?.dateOfBirthEnc).toBeTruthy();
      expect(intake?.dateOfBirthEnc).not.toContain('1990');
      expect(intake?.nationality).toBe('IN');

      // What the concierge said is recorded, in order.
      const outbound = await prisma.outboundMessage.findMany({
        where: { conversationId: conversation!.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(outbound.map((row) => row.stage)).toEqual(['NEEDS_ELIGIBILITY_INFO', 'QUOTE_ISSUED']);

      // CRM followed the journey without anyone touching it.
      const customer = await prisma.customer.findFirst({ where: { customerRef: from } });
      expect(customer?.lastQuoteId).toBe(quote!.quoteId);
    },
  );

  it(
    'accepts driver details piecemeal, including bare one-word answers',
    { timeout: 120_000 },
    async () => {
      await seedFleet();
      await seedPolicy();
      const from = '971501110002';

      await say(from, BOOKING);
      const second = await say(from, 'Indian');
      expect(second).toMatch(/date of birth/i);
      expect(second).not.toMatch(/nationality/i);

      const third = await say(from, '12 May 1990');
      expect(third).not.toMatch(/date of birth/i);
      expect(third).toMatch(/licence/i);

      const fourth = await say(from, 'I have a UAE licence');
      expect(fourth).toMatch(/passport/i);

      const fifth = await say(from, 'yes');
      expect(fifth).toMatch(/Total: AED/);
      expect((await journeyFor(from)).journey?.state).toBe('QUOTE_ISSUED');
    },
  );

  it(
    'asks for a clearer date instead of guessing an ambiguous one',
    { timeout: 120_000 },
    async () => {
      await seedFleet();
      await seedPolicy();
      const from = '971501110003';

      await say(from, BOOKING);
      const reply = await say(from, 'Indian, dob 03/04/1990, UAE licence, I have my passport');
      expect(reply).toMatch(/month in words/i);
      expect((await journeyFor(from)).journey?.state).toBe('ELIGIBILITY_CHECK');

      const done = await say(from, '3 April 1990');
      expect(done).toMatch(/Total: AED/);
    },
  );

  it(
    'declines an ineligible driver politely and closes the journey',
    { timeout: 120_000 },
    async () => {
      await seedFleet();
      await seedPolicy();
      const from = '971501110004';

      await say(from, BOOKING);
      const reply = await say(
        from,
        "I'm British, born 3 June 2005, UAE licence, and I have my passport",
      );
      expect(reply).toMatch(/not able to go ahead/i);
      const { conversation, journey } = await journeyFor(from);
      expect(journey?.state).toBe('DECLINED');
      const decision = await testApp.ctx.prisma.eligibilityDecision.findFirst({
        where: { message: { conversationId: conversation!.id } },
      });
      expect(decision?.status).toBe('INELIGIBLE');
      // No car was held and no quote issued for someone we declined.
      expect(await testApp.ctx.prisma.availabilityHold.count()).toBe(0);
      expect(await testApp.ctx.prisma.quote.count()).toBe(0);
    },
  );

  it(
    'offers alternatives when the car is not free, then quotes the one the customer picks',
    { timeout: 120_000 },
    async () => {
      await seedFleet({ urusUnits: 0 });
      await seedPolicy();
      const from = '971501110005';

      await say(from, BOOKING);
      const alternatives = await say(from, FULL_DETAILS);
      expect(alternatives).toMatch(/not available/i);
      expect(alternatives).toMatch(/Range Rover/);
      expect((await journeyFor(from)).journey?.state).toBe('OFFERING_ALTERNATIVES');
      expect(await testApp.ctx.prisma.quote.count()).toBe(0);

      const quoted = await say(from, 'The Range Rover please, same dates');
      expect(quoted).toMatch(/Range Rover/);
      expect(quoted).toMatch(/Total: AED/);
      expect((await journeyFor(from)).journey?.state).toBe('QUOTE_ISSUED');
    },
  );

  it(
    'hands an accepted quote to a person, then only acknowledges further messages',
    { timeout: 120_000 },
    async () => {
      await seedFleet();
      await seedPolicy();
      const from = '971501110006';

      await say(from, BOOKING);
      await say(from, FULL_DETAILS);

      const handoff = await say(from, 'Yes please, go ahead and book it');
      expect(handoff).toMatch(/team/i);
      expect(handoff).not.toMatch(/booking is confirmed|has been booked/i);
      const { journey } = await journeyFor(from);
      expect(journey?.state).toBe('ESCALATED');
      const escalation = await testApp.ctx.prisma.escalationCase.findFirst({
        where: { journeyId: journey!.id },
      });
      expect(escalation?.status).toBe('OPEN');
      expect(escalation?.detail).toMatch(/accepted quote/i);

      const waiting = await say(from, 'Thanks, when will they call?');
      expect(waiting).toMatch(/already looking after/i);
      expect(await testApp.ctx.prisma.escalationCase.count()).toBe(1);
    },
  );

  it(
    'answers a follow-up question about the quote without escalating',
    { timeout: 120_000 },
    async () => {
      await seedFleet();
      await seedPolicy();
      const from = '971501110007';

      await say(from, BOOKING);
      await say(from, FULL_DETAILS);
      const reply = await say(
        from,
        'What is included in that price and how does the deposit work?',
      );
      expect(reply).toMatch(/Total: AED/);
      expect((await journeyFor(from)).journey?.state).toBe('QUOTE_ISSUED');
    },
  );

  it(
    'hands over to a person the moment the customer asks for one',
    { timeout: 120_000 },
    async () => {
      await seedFleet();
      await seedPolicy();
      const from = '971501110008';

      await say(from, BOOKING);
      const reply = await say(from, 'Actually I want to speak to a human agent please');
      expect(reply).toMatch(/team/i);
      expect((await journeyFor(from)).journey?.state).toBe('ESCALATED');
      expect(await testApp.ctx.prisma.escalationCase.count()).toBe(1);
    },
  );

  it(
    'escalates instead of stalling when the tenant has no eligibility policy',
    { timeout: 120_000 },
    async () => {
      await seedFleet();
      // deliberately no seedPolicy()
      const from = '971501110009';

      await say(from, BOOKING);
      const reply = await say(from, FULL_DETAILS);
      expect(reply).toMatch(/team/i);
      expect((await journeyFor(from)).journey?.state).toBe('ESCALATED');
    },
  );

  it(
    'keeps guiding a customer who tripped the stall alert, and resumes automatically once Step 4 is done',
    { timeout: 180_000 },
    async () => {
      await seedFleet();
      await seedPolicy();
      const from = '971501110011';

      // Four turns of one-field-at-a-time booking trips Step 4's stall alert (3 attempts).
      await say(from, 'Hi');
      await say(from, 'Yes');
      const vehicleReply = await say(from, 'Lamborghini Urus');
      const nudged = await say(from, 'hmm ok');
      const { journey: stalled } = await journeyFor(from);
      expect(stalled?.state).toBe('ESCALATED');
      expect(await testApp.ctx.prisma.escalationCase.count({ where: { status: 'OPEN' } })).toBe(1);
      // The customer is NOT handed a "team is looking after you" dead end: Step 4 carries on.
      expect(nudged).toBe(vehicleReply);
      expect(nudged).not.toMatch(/already looking after/i);

      const asksDetails = await say(from, 'from 15 October to 19 October, pickup Dubai Marina');
      expect(asksDetails).toMatch(/date of birth/i);
      const { journey } = await journeyFor(from);
      expect(journey?.state).toBe('ELIGIBILITY_CHECK');
      expect(await testApp.ctx.prisma.escalationCase.count({ where: { status: 'OPEN' } })).toBe(0);
      expect(
        await testApp.ctx.prisma.escalationCase.count({ where: { status: 'CANCELLED' } }),
      ).toBe(1);

      const quote = await say(from, FULL_DETAILS);
      expect(quote).toMatch(/Total: AED/);
    },
  );

  it(
    'still hands over to a person when a stalled customer asks for one',
    { timeout: 120_000 },
    async () => {
      await seedFleet();
      await seedPolicy();
      const from = '971501110012';

      await say(from, 'Hi');
      await say(from, 'Yes');
      await say(from, 'Lamborghini Urus');
      await say(from, 'hmm ok');
      const reply = await say(from, 'can I talk to a real person please');
      expect(reply).toMatch(/already looking after/i);
      expect(await testApp.ctx.prisma.escalationCase.count()).toBe(1);
    },
  );

  it(
    'stops asking and escalates after repeated unanswered requests for details',
    { timeout: 180_000 },
    async () => {
      await seedFleet();
      await seedPolicy();
      const from = '971501110010';

      await say(from, BOOKING);
      for (const filler of ['hello?', 'any update', 'ok']) {
        await say(from, filler);
      }
      const last = await say(from, 'still waiting');
      expect(last).toMatch(/team/i);
      expect((await journeyFor(from)).journey?.state).toBe('ESCALATED');
    },
  );
});

/**
 * The same chain with a scripted Gemini in place of the unconfigured one:
 * proves the model is used where it is allowed to be (extracting driver
 * details from a message the rule-based parser cannot read; wording the reply)
 * and that a reply which invents a price never reaches the customer.
 */
describe('automatic Steps 5-8 chain with Gemini — integration', () => {
  let testApp: TestApp;
  let whatsapp: FakeWhatsAppProvider;
  let replyMode: 'echo-draft' | 'hallucinate-price' = 'echo-draft';
  const schemaCalls: string[] = [];
  let seq = 0;

  const scriptedGemini = {
    name: 'scripted-gemini',
    async generateStructured(input: { schemaName: string; prompt: string }) {
      schemaCalls.push(input.schemaName);
      let json: unknown = {};
      if (input.schemaName === 'eligibility-intake-v1') {
        json = {
          dateOfBirth: '1990-05-12',
          nationalityIso2: 'FR',
          licenseType: 'UAE',
          hasValidLicense: true,
          passportProvided: true,
          evidence: {
            dateOfBirth: 'douze mai 1990',
            nationality: 'française',
            licenseType: 'permis émirati',
            hasValidLicense: 'permis émirati',
            passportProvided: 'passeport',
          },
        };
      } else if (input.schemaName === 'journey-reply-v1') {
        const draft = /Draft to rewrite:\n"""\n([\s\S]*)\n"""/.exec(input.prompt)?.[1] ?? '';
        json = {
          reply: replyMode === 'echo-draft' ? `[AI] ${draft}` : 'Your total is AED 1,000. Enjoy!',
        };
      } else {
        json = { reply: 'Quel jour souhaitez-vous ?' };
      }
      return {
        json,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        modelId: 'scripted',
        latencyMs: 1,
      };
    },
    async healthCheck() {
      return 'CONFIGURED' as const;
    },
  };

  beforeAll(async () => {
    whatsapp = new FakeWhatsAppProvider();
    testApp = await buildTestApp(
      { WHATSAPP_APP_SECRET: APP_SECRET },
      { whatsappProvider: whatsapp, aiProvider: scriptedGemini },
    );
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
    whatsapp.sent.length = 0;
    schemaCalls.length = 0;
    replyMode = 'echo-draft';
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
      rules: DEFAULT_POLICY,
    });
  });

  async function say(from: string, text: string): Promise<string> {
    seq += 1;
    const body = metaTextPayload(`wamid.GEM-${seq}`, from, text);
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    return whatsapp.sent[whatsapp.sent.length - 1]!.body;
  }

  const FRENCH =
    "Je suis né le douze mai 1990, de nationalité française, j'ai un permis émirati et mon passeport";

  it(
    'reads driver details the rule-based parser cannot, and words the quote with the model',
    { timeout: 120_000 },
    async () => {
      const from = '971502220001';
      await say(from, BOOKING);
      const reply = await say(from, FRENCH);

      // The model extracted the details (grounded by verbatim evidence) ...
      expect(schemaCalls).toContain('eligibility-intake-v1');
      const intake = await testApp.ctx.prisma.eligibilityIntake.findFirst();
      expect(intake?.nationality).toBe('FR');
      expect(intake?.licenseType).toBe('UAE');

      // ... the chain ran to a quote, and the model's wording is what was sent.
      expect(reply).toMatch(/^\[AI\]/);
      expect(reply).toMatch(/Total: AED/);
      const outbound = await testApp.ctx.prisma.outboundMessage.findMany({
        orderBy: { createdAt: 'asc' },
      });
      expect(outbound.at(-1)?.source).toBe('AI_GENERATED');
      expect(outbound.at(-1)?.stage).toBe('QUOTE_ISSUED');
    },
  );

  it(
    'never lets a reply with an invented price reach the customer',
    { timeout: 120_000 },
    async () => {
      replyMode = 'hallucinate-price';
      const from = '971502220002';
      await say(from, BOOKING);
      const reply = await say(from, FRENCH);

      expect(reply).not.toMatch(/AED 1,000/);
      const quote = await testApp.ctx.prisma.quote.findFirst();
      const total = ((quote!.total as { minorUnits: number }).minorUnits / 100).toLocaleString(
        'en-US',
      );
      expect(reply).toContain(`Total: AED ${total}`);
      const outbound = await testApp.ctx.prisma.outboundMessage.findMany({
        orderBy: { createdAt: 'asc' },
      });
      expect(outbound.at(-1)?.source).toBe('TEMPLATE');
    },
  );
});
