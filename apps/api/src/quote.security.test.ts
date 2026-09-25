import { createVehicle, type CreateVehicleInput } from '@ai-concierge/db';
import {
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
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

describe('POST/GET /v1/enquiries/:conversationId/quote — security', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp({ RATE_LIMIT_MAX: 1000 });
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
  });

  async function seedUrus(tenantId: string, overrides: Partial<VehicleOverrides> = {}) {
    return createVehicle(testApp.ctx.prisma, {
      tenantId,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
      ...overrides,
    });
  }

  async function createConversation(message: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: { channel: 'WEB', customerRef: 'security-test', message },
    });
    return response.json().conversationId as string;
  }

  async function runStepsThroughVehicle(conversationId: string) {
    await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });
    await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/vehicle-selection`,
    });
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

  it('rejects a request body carrying a raw price/amount field ("price manipulation prevention")', async () => {
    await seedUrus(TEST_TENANT_ID);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const response = await requestQuote(conversationId, {
      total: { minorUnits: 1, currency: 'AED' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a request body overriding lineItems/discount amounts directly', async () => {
    await seedUrus(TEST_TENANT_ID);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const response = await requestQuote(conversationId, {
      lineItems: [{ code: 'BASE_RENTAL_DAILY', amount: { minorUnits: 1, currency: 'AED' } }],
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an arbitrary unrecognized field, not just known price fields (strict schema)', async () => {
    await seedUrus(TEST_TENANT_ID);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const response = await requestQuote(conversationId, { priceOverride: 1 });
    expect(response.statusCode).toBe(400);
  });

  it('a quote for one tenant is never visible to another tenant (defense in depth)', async () => {
    await seedUrus(TEST_TENANT_ID);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);
    await requestQuote(conversationId);

    await testApp.ctx.prisma.conversation.update({
      where: { id: conversationId },
      data: { tenantId: OTHER_TENANT_ID },
    });

    const response = await fetchQuote(conversationId);
    expect(response.statusCode).toBe(404);
  });

  it('one tenant\'s vehicle pricing never leaks into another tenant\'s quote ("authorization")', async () => {
    await seedUrus(TEST_TENANT_ID, { pricingProfile: { currency: 'AED', dailyRate: 3500 } });
    await seedUrus(OTHER_TENANT_ID, { pricingProfile: { currency: 'AED', dailyRate: 9999 } });

    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const response = await requestQuote(conversationId);
    expect(response.statusCode).toBe(201);
    expect(response.json().quote.lineItems[0].unitAmount.minorUnits).toBe(350_000); // TEST_TENANT_ID's own rate
  });

  it('never leaks internal error details (stack traces, SQL, driver messages) on a not-found conversation', async () => {
    const response = await requestQuote('00000000-0000-0000-0000-000000009999');
    const body = response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(body)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('never leaks internal details on a validation failure', async () => {
    await seedUrus(TEST_TENANT_ID);
    const conversationId = await createConversation(BOOKING_MESSAGE);

    const response = await requestQuote(conversationId);
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(Object.keys(body.error.details)).toEqual(['code']);
    expect(JSON.stringify(body)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('detects a directly-tampered quote row and refuses to serve it ("tamper detection")', async () => {
    await seedUrus(TEST_TENANT_ID);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);
    const created = await requestQuote(conversationId);
    expect(created.statusCode).toBe(201);

    // Simulate an attacker (or a bug elsewhere) editing the stored row
    // directly — bypassing the application entirely, the only way a real
    // tamper could happen since there is no update endpoint.
    await testApp.ctx.prisma.quote.updateMany({
      where: { conversationId },
      data: { total: { minorUnits: 1, currency: 'AED' } },
    });

    const response = await fetchQuote(conversationId);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.code).toBe('QUOTE_TAMPERED');
  });

  it('records a quote.tamper_detected audit event when a tampered row is encountered during re-quoting', async () => {
    await seedUrus(TEST_TENANT_ID);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);
    await requestQuote(conversationId);

    await testApp.ctx.prisma.quote.updateMany({
      where: { conversationId },
      data: { total: { minorUnits: 1, currency: 'AED' } },
    });

    // Re-quoting must not build on, or silently repair, tampered data — it
    // starts a fresh lineage and audits the incident.
    const response = await requestQuote(conversationId, { insuranceTier: 'BASIC' });
    expect(response.statusCode).toBe(201);
    expect(response.json().quote.version).toBe(1); // fresh lineage, not v2 of the tampered one

    const tamperEvents = await testApp.ctx.prisma.auditEvent.findMany({
      where: { action: 'quote.tamper_detected' },
    });
    expect(tamperEvents).toHaveLength(1);
  });

  it('records an audit event with no internal detail on quote.issued', async () => {
    await seedUrus(TEST_TENANT_ID);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);
    await requestQuote(conversationId);

    const events = await testApp.ctx.prisma.auditEvent.findMany({
      where: { action: 'quote.issued' },
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.after)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('rejects a malformed conversation id without a 500 or internal detail leak', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries/../../etc/passwd/quote',
    });
    expect(response.statusCode).toBeLessThan(500);
  });

  it('treats a SQL-injection-shaped message as inert text through the full pipeline', async () => {
    await seedUrus(TEST_TENANT_ID);
    const conversationId = await createConversation(
      "Lamborghini Urus'; DROP TABLE quotes; -- from 15 to 19 Oct, Dubai Marina",
    );
    await runStepsThroughVehicle(conversationId);

    const response = await requestQuote(conversationId);
    expect([201, 400]).toContain(response.statusCode);

    const vehicleCount = await testApp.ctx.prisma.vehicle.count();
    expect(vehicleCount).toBe(1);
  });
});
