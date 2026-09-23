import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createVehicle } from './vehicleRepository.js';
import {
  countUnitsByStatus,
  createVehicleUnit,
  listUnitsForVehicle,
} from './vehicleUnitRepository.js';

async function seedVehicle(prisma: PrismaClient, tenantId: string, model = 'Urus') {
  return createVehicle(prisma, {
    tenantId,
    make: 'Lamborghini',
    model,
    category: 'SUV',
    luxuryTier: 'ULTRA_LUXURY',
    seats: 5,
    luggage: 4,
    transmission: 'AUTOMATIC',
    pricingProfile: { currency: 'AED', dailyRate: 3500 },
  });
}

describe('vehicleUnitRepository', () => {
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

  it('counts active and maintenance units separately', async () => {
    const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
    await createVehicleUnit(prisma, {
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      unitRef: 'U-01',
    });
    await createVehicleUnit(prisma, {
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      unitRef: 'U-02',
    });
    await createVehicleUnit(prisma, {
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      unitRef: 'U-03',
      status: 'MAINTENANCE',
    });
    await createVehicleUnit(prisma, {
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      unitRef: 'U-04',
      status: 'RETIRED',
    });

    const counts = await countUnitsByStatus(prisma, TEST_TENANT_ID, vehicle.id);
    expect(counts).toEqual({ activeUnits: 2, maintenanceUnits: 1 });
  });

  it('returns zero counts for a vehicle with no units at all', async () => {
    const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
    const counts = await countUnitsByStatus(prisma, TEST_TENANT_ID, vehicle.id);
    expect(counts).toEqual({ activeUnits: 0, maintenanceUnits: 0 });
  });

  it('is unique per (tenantId, vehicleId, unitRef) but allows the same unitRef for a different tenant', async () => {
    const mine = await seedVehicle(prisma, TEST_TENANT_ID);
    const theirs = await seedVehicle(prisma, OTHER_TENANT_ID);

    await createVehicleUnit(prisma, {
      tenantId: TEST_TENANT_ID,
      vehicleId: mine.id,
      unitRef: 'U-01',
    });
    await expect(
      createVehicleUnit(prisma, { tenantId: TEST_TENANT_ID, vehicleId: mine.id, unitRef: 'U-01' }),
    ).rejects.toThrow();

    await expect(
      createVehicleUnit(prisma, {
        tenantId: OTHER_TENANT_ID,
        vehicleId: theirs.id,
        unitRef: 'U-01',
      }),
    ).resolves.toMatchObject({ unitRef: 'U-01' });
  });

  it('scopes counts and listings to the requesting tenant', async () => {
    const mine = await seedVehicle(prisma, TEST_TENANT_ID);
    const theirs = await seedVehicle(prisma, OTHER_TENANT_ID);
    await createVehicleUnit(prisma, {
      tenantId: TEST_TENANT_ID,
      vehicleId: mine.id,
      unitRef: 'U-01',
    });
    await createVehicleUnit(prisma, {
      tenantId: OTHER_TENANT_ID,
      vehicleId: theirs.id,
      unitRef: 'U-01',
    });
    await createVehicleUnit(prisma, {
      tenantId: OTHER_TENANT_ID,
      vehicleId: theirs.id,
      unitRef: 'U-02',
    });

    expect(await countUnitsByStatus(prisma, TEST_TENANT_ID, mine.id)).toEqual({
      activeUnits: 1,
      maintenanceUnits: 0,
    });
    expect(await countUnitsByStatus(prisma, OTHER_TENANT_ID, theirs.id)).toEqual({
      activeUnits: 2,
      maintenanceUnits: 0,
    });

    const mineList = await listUnitsForVehicle(prisma, TEST_TENANT_ID, mine.id);
    expect(mineList).toHaveLength(1);
  });
});
