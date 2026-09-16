import { createVehicle } from '@ai-concierge/db';
import {
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

describe('POST /v1/enquiries/:conversationId/vehicle-selection — integration', () => {
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

  async function seedFleet() {
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
    return { urus, rangeRover };
  }

  async function createConversation(message: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: { channel: 'WEB', customerRef: 'web-session-1', message },
    });
    expect(response.statusCode).toBe(201);
    return response.json().conversationId as string;
  }

  async function determine(conversationId: string) {
    return testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/vehicle-selection`,
    });
  }

  it('resolves an exact make+model mention', async () => {
    const { urus } = await seedFleet();
    const conversationId = await createConversation('I want to rent a Lamborghini Urus');

    const response = await determine(conversationId);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.conversationId).toBe(conversationId);
    expect(body.determination.status).toBe('RESOLVED');
    expect(body.determination.resolvedVehicle.id).toBe(urus.id);
  });

  it('resolves a brand-only mention when it is unambiguous', async () => {
    const { urus } = await seedFleet();
    const conversationId = await createConversation('Do you have a Lamborghini available?');

    const response = await determine(conversationId);
    expect(response.statusCode).toBe(201);
    expect(response.json().determination.resolvedVehicle.id).toBe(urus.id);
  });

  it('needs clarification with both vehicles as alternatives for a category-only mention', async () => {
    const { urus, rangeRover } = await seedFleet();
    const conversationId = await createConversation('I need an SUV for my trip to Dubai');

    const response = await determine(conversationId);
    expect(response.statusCode).toBe(201);
    const { determination } = response.json();
    expect(determination.status).toBe('NEEDS_CLARIFICATION');
    expect(determination.resolvedVehicle).toBeNull();
    const alternativeIds = determination.alternatives.map((v: { id: string }) => v.id).sort();
    expect(alternativeIds).toEqual([urus.id, rangeRover.id].sort());
  });

  it('resolves a typo via fuzzy matching', async () => {
    const { rangeRover } = await seedFleet();
    const conversationId = await createConversation('Can I get the Range Rovr this weekend');

    const response = await determine(conversationId);
    expect(response.statusCode).toBe(201);
    const { determination } = response.json();
    expect(determination.status).toBe('RESOLVED');
    expect(determination.resolvedVehicle.id).toBe(rangeRover.id);
    expect(determination.confidence).toBeLessThan(1);
  });

  it('is unsupported with real alternatives for a vehicle outside the fleet', async () => {
    await seedFleet();
    const conversationId = await createConversation('I would like to rent a Toyota Corolla');

    const response = await determine(conversationId);
    expect(response.statusCode).toBe(201);
    const { determination } = response.json();
    expect(determination.status).toBe('UNSUPPORTED');
    expect(determination.resolvedVehicle).toBeNull();
    expect(determination.validationErrors).toContainEqual(
      expect.objectContaining({ code: 'UNKNOWN_VEHICLE' }),
    );
    expect(determination.alternatives.length).toBeGreaterThan(0);
  });

  it('is unsupported with alternatives for an exactly-named but inactive vehicle', async () => {
    const { rangeRover } = await seedFleet();
    await createVehicle(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Bentley',
      model: 'Continental',
      category: 'COUPE',
      luxuryTier: 'LUXURY',
      seats: 4,
      luggage: 3,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 2200 },
      active: false,
    });
    const conversationId = await createConversation('I want the Bentley Continental please');

    const response = await determine(conversationId);
    expect(response.statusCode).toBe(201);
    const { determination } = response.json();
    expect(determination.status).toBe('UNSUPPORTED');
    expect(determination.resolvedVehicle).toBeNull();
    expect(determination.validationErrors).toContainEqual(
      expect.objectContaining({ code: 'VEHICLE_INACTIVE' }),
    );
    // Alternatives fall back to the same category (COUPE has none active), so
    // the generic active fleet is offered instead of a dead end.
    expect(determination.alternatives.map((v: { id: string }) => v.id)).toContain(rangeRover.id);
  });

  it('persists the determination and an audit event', async () => {
    await seedFleet();
    const conversationId = await createConversation('I want a Lamborghini Urus');
    await determine(conversationId);

    const count = await testApp.ctx.prisma.vehicleDetermination.count();
    expect(count).toBe(1);

    const auditRows = await testApp.ctx.prisma.auditEvent.findMany({
      where: { action: 'vehicle.determined' },
    });
    expect(auditRows).toHaveLength(1);
  });

  it('never matches a vehicle that only exists in another tenant fleet', async () => {
    await createVehicle(testApp.ctx.prisma, {
      tenantId: OTHER_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
    const conversationId = await createConversation('I want a Lamborghini Urus');

    const response = await determine(conversationId);
    expect(response.statusCode).toBe(201);
    const { determination } = response.json();
    expect(determination.status).toBe('UNSUPPORTED');
    expect(determination.resolvedVehicle).toBeNull();
  });

  it('returns 404 for an unknown conversation', async () => {
    const response = await determine('00000000-0000-0000-0000-000000009999');
    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for a malformed conversation id', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries/not-a-uuid/vehicle-selection',
    });
    expect(response.statusCode).toBe(400);
  });
});
