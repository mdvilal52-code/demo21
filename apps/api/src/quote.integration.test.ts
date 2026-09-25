import { createVehicle, type CreateVehicleInput } from '@ai-concierge/db';
import { DEFAULT_PRICING_RULES, PricingRules } from '@ai-concierge/ai';
import { seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

const BOOKING_MESSAGE =
  'I want to rent a Lamborghini Urus from 15 to 19 Oct, pickup in Dubai Marina';

type VehicleOverrides = Pick<
  CreateVehicleInput,
  'make' | 'model' | 'category' | 'luxuryTier' | 'pricingProfile'
> &
  Partial<
    Omit<
      CreateVehicleInput,
      'tenantId' | 'make' | 'model' | 'category' | 'luxuryTier' | 'pricingProfile'
    >
  >;

describe('POST /v1/enquiries/:conversationId/quote — integration', () => {
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

  async function seedVehicle(overrides: VehicleOverrides) {
    return createVehicle(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      ...overrides,
    });
  }

  async function seedUrus(
    pricingProfile: CreateVehicleInput['pricingProfile'] = { currency: 'AED', dailyRate: 3500 },
  ) {
    return seedVehicle({
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      pricingProfile,
    });
  }

  async function createConversation(message: string, customerRef = 'web-session-1') {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: { channel: 'WEB', customerRef, message },
    });
    expect(response.statusCode).toBe(201);
    return response.json().conversationId as string;
  }

  async function runStepsThroughVehicle(conversationId: string) {
    const dates = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });
    expect(dates.statusCode).toBe(201);
    const vehicle = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/vehicle-selection`,
    });
    expect(vehicle.statusCode).toBe(201);
  }

  async function requestQuote(conversationId: string, body: Record<string, unknown> = {}) {
    return testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/quote`,
      payload: body,
    });
  }

  async function fetchQuote(conversationId: string) {
    return testApp.app.inject({ method: 'GET', url: `/v1/enquiries/${conversationId}/quote` });
  }

  it('prices a plain 4-day rental with the exact expected total ("4 days")', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const response = await requestQuote(conversationId);
    expect(response.statusCode).toBe(201);
    const { quote } = response.json();
    expect(quote.status).toBe('ISSUED');
    expect(quote.version).toBe(1);
    expect(quote.total).toEqual({ minorUnits: 1_475_250, currency: 'AED' });
    expect(quote.lineItems[0]).toMatchObject({ code: 'BASE_RENTAL_DAILY', quantity: 4 });
  });

  it('includes a service fee line ("fees")', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const { quote } = (await requestQuote(conversationId)).json();
    expect(quote.fees).toEqual([
      expect.objectContaining({
        code: 'SERVICE_FEE',
        amount: { minorUnits: 5000, currency: 'AED' },
      }),
    ]);
  });

  it('computes VAT at the configured rate ("tax")', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const { quote } = (await requestQuote(conversationId)).json();
    expect(quote.taxes).toEqual([
      expect.objectContaining({
        code: 'VAT',
        ratePercent: 5,
        amount: { minorUnits: 70_250, currency: 'AED' },
      }),
    ]);
  });

  it('applies a valid discount code ("discount")', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const response = await requestQuote(conversationId, { discountCode: 'WELCOME10' });
    expect(response.statusCode).toBe(201);
    const { quote } = response.json();
    expect(quote.discounts).toEqual([
      expect.objectContaining({
        code: 'WELCOME10',
        amount: { minorUnits: 140_000, currency: 'AED' },
      }),
    ]);
    expect(quote.total.minorUnits).toBe(1_328_250);
  });

  it('rounds VAT round-half-up, exactly once ("rounding")', async () => {
    await seedUrus({ currency: 'AED', dailyRate: 100.03 });
    // A 1-day range ("15 to 16 Oct"), not the shared 4-day BOOKING_MESSAGE —
    // keeps this test's numbers directly comparable to pricingCalculator's
    // own unit test for the identical (dailyRate, 1 day) input.
    const conversationId = await createConversation(
      'I want to rent a Lamborghini Urus from 15 to 16 Oct, pickup in Dubai Marina',
    );
    await runStepsThroughVehicle(conversationId);

    const { quote } = (await requestQuote(conversationId)).json();
    expect(quote.taxes[0].amount.minorUnits).toBe(750);
    expect(quote.total.minorUnits).toBe(15_753);
  });

  it('never lets an oversized discount push the total negative ("zero/negative values")', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);
    testApp.ctx.pricingRules = new PricingRules({
      ...DEFAULT_PRICING_RULES,
      discounts: [{ code: 'MEGA', description: 'test', percentOff: 150 }],
    });

    const response = await requestQuote(conversationId, { discountCode: 'MEGA' });
    expect(response.statusCode).toBe(201);
    const { quote } = response.json();
    expect(quote.total.minorUnits).toBeGreaterThanOrEqual(0);
    expect(quote.total.minorUnits).toBe(5_250);

    testApp.ctx.pricingRules = new PricingRules();
  });

  it('rejects a quote request once the resolved pickup date has slipped into the past (staleness re-check)', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    // Simulate time passing since Step 2 resolved these dates — the same
    // staleness Step 6's own orchestrator re-checks on every run.
    await testApp.ctx.prisma.dateLocationExtraction.updateMany({
      where: { message: { conversation: { id: conversationId } } },
      data: { pickupDate: new Date('2000-01-01T00:00:00.000Z') },
    });

    const response = await requestQuote(conversationId);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.code).toBe('PICKUP_DATE_NOW_IN_PAST');
  });

  it('rejects a quote request when the resolved return date is no longer after pickup (staleness re-check)', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const extraction = await testApp.ctx.prisma.dateLocationExtraction.findFirstOrThrow({
      where: { message: { conversation: { id: conversationId } } },
      orderBy: { createdAt: 'desc' },
    });
    // Equal to whatever pickup Step 2 actually resolved — guaranteed to
    // trigger RETURN_BEFORE_OR_EQUAL_PICKUP regardless of the exact time.
    await testApp.ctx.prisma.dateLocationExtraction.update({
      where: { id: extraction.id },
      data: { returnDate: extraction.pickupDate },
    });

    const response = await requestQuote(conversationId);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.code).toBe('RETURN_BEFORE_OR_EQUAL_PICKUP');
  });

  it('rejects a vehicle priced in a different currency than the pricing rules ("currency mismatch")', async () => {
    await seedUrus({ currency: 'USD', dailyRate: 900 });
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const response = await requestQuote(conversationId);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.code).toBe('CURRENCY_MISMATCH');
  });

  it('never reuses an already-expired quote, and GET reports QUOTE_EXPIRED ("expired quote")', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);
    testApp.ctx.pricingRules = new PricingRules({ ...DEFAULT_PRICING_RULES, validityHours: -1 });

    const first = await requestQuote(conversationId);
    expect(first.statusCode).toBe(201);
    expect(first.json().quote.version).toBe(1);

    const second = await requestQuote(conversationId);
    expect(second.statusCode).toBe(201);
    expect(second.json().quote.version).toBe(2); // not reused — the existing one had already expired

    const fetched = await fetchQuote(conversationId);
    expect(fetched.statusCode).toBe(400);
    expect(fetched.json().error.details.code).toBe('QUOTE_EXPIRED');

    testApp.ctx.pricingRules = new PricingRules();
  });

  it('returns the same version for an identical, unexpired repeat request ("duplicate quote")', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const first = await requestQuote(conversationId, { insuranceTier: 'BASIC' });
    const second = await requestQuote(conversationId, { insuranceTier: 'BASIC' });

    expect(first.json().quote.quoteId).toBe(second.json().quote.quoteId);
    expect(first.json().quote.version).toBe(1);
    expect(second.json().quote.version).toBe(1);

    const rows = await testApp.ctx.prisma.quote.findMany({ where: { conversationId } });
    expect(rows).toHaveLength(1);
  });

  it('creates a new version when selections actually change', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const first = await requestQuote(conversationId, {});
    const second = await requestQuote(conversationId, { extraCodes: ['GPS'] });

    expect(first.json().quote.quoteId).toBe(second.json().quote.quoteId);
    expect(second.json().quote.version).toBe(2);
  });

  it('converges N concurrent identical requests on a single quote ("concurrent quote generation")', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => requestQuote(conversationId, { insuranceTier: 'PREMIUM' })),
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(201);
    }
    const quoteIds = new Set(responses.map((r) => r.json().quote.quoteId));
    const versions = new Set(responses.map((r) => r.json().quote.version));
    expect(quoteIds.size).toBe(1);
    expect(versions).toEqual(new Set([1]));

    const rows = await testApp.ctx.prisma.quote.findMany({ where: { conversationId } });
    expect(rows).toHaveLength(1);
  });

  it('flags a large discount for human review and issues status PENDING_REVIEW', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);
    testApp.ctx.pricingRules = new PricingRules({
      ...DEFAULT_PRICING_RULES,
      discounts: [{ code: 'BIGDEAL', description: 'Large discount', percentOff: 30 }],
    });

    const response = await requestQuote(conversationId, { discountCode: 'BIGDEAL' });
    expect(response.statusCode).toBe(201);
    const { quote } = response.json();
    expect(quote.status).toBe('PENDING_REVIEW');
    expect(quote.requiresHumanReview).toBe(true);
    expect(quote.reviewReasons.length).toBeGreaterThan(0);

    testApp.ctx.pricingRules = new PricingRules();
  });

  it('returns 400 VEHICLE_NOT_RESOLVED when Step 3 has not run yet', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });

    const response = await requestQuote(conversationId);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.code).toBe('VEHICLE_NOT_RESOLVED');
  });

  it('returns 400 DATES_NOT_RESOLVED when Step 2 has not run yet', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/vehicle-selection`,
    });

    const response = await requestQuote(conversationId);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.code).toBe('DATES_NOT_RESOLVED');
  });

  it('returns 404 for an unknown conversation', async () => {
    const response = await requestQuote('00000000-0000-0000-0000-000000009999');
    expect(response.statusCode).toBe(404);
  });

  it('rejects an unknown extra code', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const response = await requestQuote(conversationId, { extraCodes: ['NOT_REAL'] });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.code).toBe('UNKNOWN_EXTRA_CODE');
  });

  it('rejects an unknown discount code', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const response = await requestQuote(conversationId, { discountCode: 'NOT_REAL' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.code).toBe('UNKNOWN_DISCOUNT_CODE');
  });

  it('persists a Quote row and an audit event ("audit trail")', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);
    await requestQuote(conversationId);

    const rows = await testApp.ctx.prisma.quote.findMany({ where: { conversationId } });
    expect(rows).toHaveLength(1);

    const auditRows = await testApp.ctx.prisma.auditEvent.findMany({
      where: { action: 'quote.issued' },
    });
    expect(auditRows).toHaveLength(1);
  });

  it('GET returns 404 QUOTE_NOT_FOUND before any quote has been generated', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const response = await fetchQuote(conversationId);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.details.code).toBe('QUOTE_NOT_FOUND');
  });

  it('GET returns the current quote after one has been issued', async () => {
    await seedUrus();
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);
    const created = await requestQuote(conversationId);

    const fetched = await fetchQuote(conversationId);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().quote.quoteId).toBe(created.json().quote.quoteId);
    expect(fetched.json().quote.total).toEqual(created.json().quote.total);
  });
});
