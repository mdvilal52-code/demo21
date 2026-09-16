import type { PricingProfile } from '@ai-concierge/domain';
import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createVehicle,
  findAlternativeVehicles,
  findVehiclesByIds,
  listVehicleLexicon,
  normalizeVehicleName,
  softDeleteVehicle,
} from './vehicleRepository.js';

const URUS_PRICING: PricingProfile = {
  currency: 'AED',
  dailyRate: 3500,
  weeklyRate: 21000,
  depositAmount: 10000,
};

const RANGE_ROVER_PRICING: PricingProfile = {
  currency: 'AED',
  dailyRate: 1800,
  weeklyRate: 10800,
  depositAmount: 5000,
};

describe('normalizeVehicleName', () => {
  it('title-cases regardless of input casing', () => {
    expect(normalizeVehicleName('lamborghini')).toBe('Lamborghini');
    expect(normalizeVehicleName('LAMBORGHINI')).toBe('Lamborghini');
    expect(normalizeVehicleName('range rover')).toBe('Range Rover');
  });
});

describe('vehicleRepository', () => {
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

  it('creates a vehicle with a normalized name', async () => {
    const vehicle = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'lamborghini',
      model: 'urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: URUS_PRICING,
    });
    expect(vehicle.make).toBe('Lamborghini');
    expect(vehicle.model).toBe('Urus');
    expect(vehicle.active).toBe(true);
    expect(vehicle.availabilityStatus).toBe('AVAILABLE');
    expect(vehicle.deletedAt).toBeNull();
  });

  it('rejects a duplicate (tenantId, make, model), even with different casing', async () => {
    await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: URUS_PRICING,
    });

    await expect(
      createVehicle(prisma, {
        tenantId: TEST_TENANT_ID,
        make: 'LAMBORGHINI',
        model: 'URUS',
        category: 'SUV',
        luxuryTier: 'ULTRA_LUXURY',
        seats: 5,
        luggage: 4,
        transmission: 'AUTOMATIC',
        pricingProfile: URUS_PRICING,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('allows the same make/model for two different tenants', async () => {
    await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: URUS_PRICING,
    });

    await expect(
      createVehicle(prisma, {
        tenantId: OTHER_TENANT_ID,
        make: 'Lamborghini',
        model: 'Urus',
        category: 'SUV',
        luxuryTier: 'ULTRA_LUXURY',
        seats: 5,
        luggage: 4,
        transmission: 'AUTOMATIC',
        pricingProfile: URUS_PRICING,
      }),
    ).resolves.toMatchObject({ make: 'Lamborghini', model: 'Urus' });
  });

  it('soft-deletes a vehicle: excluded from the lexicon and findByIds, idempotent on a second call', async () => {
    const vehicle = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: URUS_PRICING,
    });

    const firstDelete = await softDeleteVehicle(prisma, TEST_TENANT_ID, vehicle.id);
    expect(firstDelete.count).toBe(1);

    const secondDelete = await softDeleteVehicle(prisma, TEST_TENANT_ID, vehicle.id);
    expect(secondDelete.count).toBe(0);

    const lexicon = await listVehicleLexicon(prisma, TEST_TENANT_ID);
    expect(lexicon).toHaveLength(0);

    const byId = await findVehiclesByIds(prisma, TEST_TENANT_ID, [vehicle.id]);
    expect(byId).toHaveLength(0);
  });

  it('lexicon includes inactive/unavailable vehicles but not soft-deleted ones', async () => {
    const active = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: URUS_PRICING,
    });
    const inactive = await createVehicle(prisma, {
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
    const deleted = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Rolls-Royce',
      model: 'Cullinan',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 5,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 5000 },
    });
    await softDeleteVehicle(prisma, TEST_TENANT_ID, deleted.id);

    const lexicon = await listVehicleLexicon(prisma, TEST_TENANT_ID);
    const ids = lexicon.map((entry) => entry.id).sort();
    expect(ids).toEqual([active.id, inactive.id].sort());
    expect(lexicon.find((entry) => entry.id === inactive.id)?.active).toBe(false);
  });

  it('scopes the lexicon and findByIds to the requesting tenant', async () => {
    const mine = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: URUS_PRICING,
    });
    const theirs = await createVehicle(prisma, {
      tenantId: OTHER_TENANT_ID,
      make: 'Land Rover',
      model: 'Range Rover',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      seats: 5,
      luggage: 5,
      transmission: 'AUTOMATIC',
      pricingProfile: RANGE_ROVER_PRICING,
    });

    const lexicon = await listVehicleLexicon(prisma, TEST_TENANT_ID);
    expect(lexicon.map((entry) => entry.id)).toEqual([mine.id]);

    const crossTenantLookup = await findVehiclesByIds(prisma, TEST_TENANT_ID, [theirs.id]);
    expect(crossTenantLookup).toHaveLength(0);

    const ownLookup = await findVehiclesByIds(prisma, OTHER_TENANT_ID, [theirs.id]);
    expect(ownLookup).toHaveLength(1);
  });

  it('findAlternativeVehicles only returns active+available, non-deleted vehicles, filtered by category and excludeIds', async () => {
    const urus = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: URUS_PRICING,
    });
    const rangeRover = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Land Rover',
      model: 'Range Rover',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      seats: 5,
      luggage: 5,
      transmission: 'AUTOMATIC',
      pricingProfile: RANGE_ROVER_PRICING,
    });
    const inMaintenance = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Rolls-Royce',
      model: 'Cullinan',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 5,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 5000 },
      availabilityStatus: 'MAINTENANCE',
    });
    const sedan = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Mercedes-Benz',
      model: 'S-Class',
      category: 'SEDAN',
      luxuryTier: 'LUXURY',
      seats: 5,
      luggage: 3,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 1500 },
    });
    void inMaintenance;

    const suvAlternatives = await findAlternativeVehicles(prisma, TEST_TENANT_ID, {
      category: 'SUV',
      excludeIds: [urus.id],
    });
    expect(suvAlternatives.map((v) => v.id)).toEqual([rangeRover.id]);

    const allAlternatives = await findAlternativeVehicles(prisma, TEST_TENANT_ID, {});
    const allIds = allAlternatives.map((v) => v.id).sort();
    expect(allIds).toEqual([urus.id, rangeRover.id, sedan.id].sort());
  });
});
