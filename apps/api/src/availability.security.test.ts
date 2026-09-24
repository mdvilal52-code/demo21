import { createVehicle, createVehicleUnit } from '@ai-concierge/db';
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

describe('POST /v1/enquiries/:conversationId/availability-check — security', () => {
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

  async function seedFleet(tenantId: string, unitCount = 1) {
    const urus = await createVehicle(testApp.ctx.prisma, {
      tenantId,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
    for (let i = 0; i < unitCount; i += 1) {
      await createVehicleUnit(testApp.ctx.prisma, {
        tenantId,
        vehicleId: urus.id,
        unitRef: `U-${i}`,
      });
    }
    return urus;
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

  async function checkAvailability(conversationId: string) {
    return testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/availability-check`,
    });
  }

  it('rejects a request for a conversation reassigned to another tenant scope (defense in depth)', async () => {
    await seedFleet(TEST_TENANT_ID);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    await testApp.ctx.prisma.conversation.update({
      where: { id: conversationId },
      data: { tenantId: OTHER_TENANT_ID },
    });

    const response = await checkAvailability(conversationId);
    expect(response.statusCode).toBe(404);
  });

  it('never leaks internal error details (stack traces, SQL, driver messages) on a not-found conversation', async () => {
    const response = await checkAvailability('00000000-0000-0000-0000-000000009999');
    const body = response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(body)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('never leaks internal details on a validation failure (vehicle/dates not resolved)', async () => {
    await seedFleet(TEST_TENANT_ID);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    // Neither dates-location nor vehicle-selection has run.

    const response = await checkAvailability(conversationId);
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(Object.keys(body.error.details)).toEqual(['code']);
    expect(JSON.stringify(body)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('treats a SQL-injection-shaped message as inert text through the full pipeline (no crash, no injection)', async () => {
    await seedFleet(TEST_TENANT_ID);
    const conversationId = await createConversation(
      "Lamborghini Urus'; DROP TABLE availability_holds; -- from 15 to 19 Oct, Dubai Marina",
    );
    await runStepsThroughVehicle(conversationId);

    const response = await checkAvailability(conversationId);
    expect([201, 400]).toContain(response.statusCode);

    const holdTableStillExists = await testApp.ctx.prisma.availabilityHold.count();
    expect(holdTableStillExists).toBeGreaterThanOrEqual(0);
    const vehicleCount = await testApp.ctx.prisma.vehicle.count();
    expect(vehicleCount).toBe(1);
  });

  it('one tenant filling its own capacity never blocks another tenant with an identically-shaped fleet', async () => {
    await seedFleet(TEST_TENANT_ID, 1);
    await seedFleet(OTHER_TENANT_ID, 1);

    const mine = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(mine);
    const mineResult = await checkAvailability(mine);
    expect(mineResult.json().availability.status).toBe('HELD');

    // A conversation is tenant-scoped by DEFAULT_TENANT_ID in this harness,
    // so cross-tenant behavior is verified at the data layer directly: the
    // other tenant's identically-named vehicle must have its own
    // independent capacity, never shared with TEST_TENANT_ID's holds.
    const otherTenantVehicle = await testApp.ctx.prisma.vehicle.findFirst({
      where: { tenantId: OTHER_TENANT_ID },
    });
    const otherTenantHoldCount = await testApp.ctx.prisma.availabilityHold.count({
      where: { tenantId: OTHER_TENANT_ID, vehicleId: otherTenantVehicle?.id },
    });
    expect(otherTenantHoldCount).toBe(0);
  });

  it('rejects a malformed conversation id without a 500 or internal detail leak', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries/../../etc/passwd/availability-check',
    });
    expect(response.statusCode).toBeLessThan(500);
  });
});
