import { FleetProviderError, type FleetProvider } from '@ai-concierge/ai';
import { createVehicle, createVehicleUnit, type PrismaClient } from '@ai-concierge/db';
import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaAvailabilityProvider } from './availabilityProvider.js';
import { DatabaseFleetProvider } from './fleetProvider.js';

const PICKUP = new Date('2026-10-05T10:00:00.000Z');
const RETURN = new Date('2026-10-08T10:00:00.000Z');

describe('PrismaAvailabilityProvider', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedTestTenants(prisma);
  });

  it('reports AVAILABLE for a vehicle with free capacity, without creating any hold (non-committal read)', async () => {
    const vehicle = await createVehicle(prisma, {
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
    await createVehicleUnit(prisma, {
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      unitRef: 'U-1',
    });

    const provider = new PrismaAvailabilityProvider(prisma, new DatabaseFleetProvider(prisma), {
      bufferMinutes: 0,
    });

    const outcome = await provider.checkAvailability({
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      pickupAt: PICKUP,
      returnAt: RETURN,
    });

    expect(outcome.status).toBe('AVAILABLE');
    expect(await prisma.availabilityHold.count()).toBe(0);
  });

  it('reports UNAVAILABLE for a vehicle id that does not exist for this tenant', async () => {
    const provider = new PrismaAvailabilityProvider(prisma, new DatabaseFleetProvider(prisma), {
      bufferMinutes: 0,
    });
    const outcome = await provider.checkAvailability({
      tenantId: TEST_TENANT_ID,
      vehicleId: randomUUID(),
      pickupAt: PICKUP,
      returnAt: RETURN,
    });
    expect(outcome.status).toBe('UNAVAILABLE');
  });

  it('reports UNKNOWN + retryable when the fleet provider fails, never a fabricated status', async () => {
    const vehicle = await createVehicle(prisma, {
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
    const failingProvider: FleetProvider = {
      name: 'always-fails',
      getInventorySnapshot: async () => {
        throw new FleetProviderError('down', { retryable: true });
      },
    };
    const provider = new PrismaAvailabilityProvider(prisma, failingProvider, { bufferMinutes: 0 });

    const outcome = await provider.checkAvailability({
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      pickupAt: PICKUP,
      returnAt: RETURN,
    });
    expect(outcome).toMatchObject({ status: 'UNKNOWN', retryable: true });
  });

  it('reports UNAVAILABLE once existing holds consume all capacity', async () => {
    const vehicle = await createVehicle(prisma, {
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
    await createVehicleUnit(prisma, {
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      unitRef: 'U-1',
    });
    await prisma.availabilityHold.create({
      data: {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: 'someone-elses-hold',
        requestedBy: 'other-customer',
      },
    });

    const provider = new PrismaAvailabilityProvider(prisma, new DatabaseFleetProvider(prisma), {
      bufferMinutes: 0,
    });
    const outcome = await provider.checkAvailability({
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      pickupAt: PICKUP,
      returnAt: RETURN,
    });
    expect(outcome.status).toBe('UNAVAILABLE');
  });
});
