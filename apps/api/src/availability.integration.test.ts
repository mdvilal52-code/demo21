import { createVehicle, createVehicleUnit } from '@ai-concierge/db';
import { seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

const BOOKING_MESSAGE =
  'I want to rent a Lamborghini Urus from 15 to 19 Oct, pickup in Dubai Marina';

describe('POST /v1/enquiries/:conversationId/availability-check — integration', () => {
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

  async function seedFleet(unitCount: number) {
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
    for (let i = 0; i < unitCount; i += 1) {
      await createVehicleUnit(testApp.ctx.prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: urus.id,
        unitRef: `U-${i}`,
      });
    }
    return urus;
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
    return { dates: dates.json(), vehicle: vehicle.json() };
  }

  async function checkAvailability(conversationId: string) {
    return testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/availability-check`,
    });
  }

  it('holds the vehicle for a fully-resolved conversation (the golden path)', async () => {
    const urus = await seedFleet(2);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const response = await checkAvailability(conversationId);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.conversationId).toBe(conversationId);
    expect(body.availability.status).toBe('HELD');
    expect(body.availability.vehicleId).toBe(urus.id);
    expect(body.availability.hold).toMatchObject({ vehicleId: urus.id, status: 'ACTIVE' });
    expect(new Date(body.availability.hold.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('persists an AvailabilityCheck row and an audit event', async () => {
    await seedFleet(2);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);
    await checkAvailability(conversationId);

    const rows = await testApp.ctx.prisma.availabilityCheck.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('HELD');

    const auditRows = await testApp.ctx.prisma.auditEvent.findMany({
      where: { action: 'availability.checked' },
    });
    expect(auditRows).toHaveLength(1);
  });

  it('replays the same hold on a repeated call (duplicate request), never double-consuming capacity', async () => {
    await seedFleet(1);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    const first = await checkAvailability(conversationId);
    const second = await checkAvailability(conversationId);

    expect(first.json().availability.hold.id).toBe(second.json().availability.hold.id);
    const activeCount = await testApp.ctx.prisma.availabilityHold.count({
      where: { status: 'ACTIVE' },
    });
    expect(activeCount).toBe(1);
  });

  it('reports UNAVAILABLE once another conversation has already taken the last unit', async () => {
    const urus = await seedFleet(1);
    void urus;

    const firstConversation = await createConversation(BOOKING_MESSAGE, 'customer-a');
    await runStepsThroughVehicle(firstConversation);
    const firstResult = await checkAvailability(firstConversation);
    expect(firstResult.json().availability.status).toBe('HELD');

    const secondConversation = await createConversation(BOOKING_MESSAGE, 'customer-b');
    await runStepsThroughVehicle(secondConversation);
    const secondResult = await checkAvailability(secondConversation);
    expect(secondResult.json().availability.status).toBe('UNAVAILABLE');
    expect(secondResult.json().availability.hold).toBeNull();
  });

  it('returns 400 VEHICLE_NOT_RESOLVED when Step 3 has not run yet', async () => {
    await seedFleet(1);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    // Only run dates-location, skip vehicle-selection.
    await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });

    const response = await checkAvailability(conversationId);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.code).toBe('VEHICLE_NOT_RESOLVED');
  });

  it('returns 400 DATES_NOT_RESOLVED when Step 2 has not run yet', async () => {
    await seedFleet(1);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    // Only run vehicle-selection, skip dates-location.
    await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/vehicle-selection`,
    });

    const response = await checkAvailability(conversationId);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.code).toBe('DATES_NOT_RESOLVED');
  });

  it('returns 404 for an unknown conversation', async () => {
    const response = await checkAvailability('00000000-0000-0000-0000-000000009999');
    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for a malformed conversation id', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries/not-a-uuid/availability-check',
    });
    expect(response.statusCode).toBe(400);
  });

  it('reports MAINTENANCE when the vehicle goes into maintenance after Step 3 already resolved it (defense in depth)', async () => {
    // Step 3 itself already refuses to resolve a vehicle that is already
    // MAINTENANCE at determination time (VEHICLE_UNAVAILABLE) — so the only
    // realistic way Step 6 ever sees a MAINTENANCE vehicle is a status
    // change *after* Step 3 ran (e.g. an admin action), which is exactly
    // what this re-validates: never trust that an earlier step's read is
    // still true now.
    const urus = await seedFleet(1);
    const conversationId = await createConversation(BOOKING_MESSAGE);
    await runStepsThroughVehicle(conversationId);

    await testApp.ctx.prisma.vehicle.update({
      where: { id: urus.id },
      data: { availabilityStatus: 'MAINTENANCE' },
    });

    const response = await checkAvailability(conversationId);
    expect(response.statusCode).toBe(201);
    expect(response.json().availability.status).toBe('MAINTENANCE');
  });
});
