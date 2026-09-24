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
  countOverlappingHolds,
  expireDueHolds,
  findHoldByIdempotencyKey,
  findHoldById,
  insertHold,
  isUniqueConstraintViolation,
  toDomainHold,
  updateHoldStatus,
} from './availabilityHoldRepository.js';

const HOUR_MS = 60 * 60 * 1000;

async function seedVehicle(prisma: PrismaClient, tenantId: string) {
  return createVehicle(prisma, {
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
}

describe('availabilityHoldRepository', () => {
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

  describe('insertHold + findHoldByIdempotencyKey', () => {
    it('creates an ACTIVE hold and finds it by idempotency key', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const now = new Date('2026-10-01T00:00:00.000Z');
      const created = await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
        idempotencyKey: 'key-1',
        requestedBy: 'test',
      });
      expect(created.status).toBe('ACTIVE');
      expect(created.version).toBe(0);

      const found = await findHoldByIdempotencyKey(prisma, TEST_TENANT_ID, 'key-1');
      expect(found?.id).toBe(created.id);
    });

    it('enforces uniqueness of (tenantId, idempotencyKey) — a duplicate request cannot double-insert (duplicate request)', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const input = {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:15:00.000Z'),
        idempotencyKey: 'dup-key',
        requestedBy: 'test',
      };
      await insertHold(prisma, input);

      const error = await insertHold(prisma, input).catch((e: unknown) => e);
      expect(isUniqueConstraintViolation(error)).toBe(true);
    });

    it('allows the same idempotency key string for two different tenants', async () => {
      const mine = await seedVehicle(prisma, TEST_TENANT_ID);
      const theirs = await seedVehicle(prisma, OTHER_TENANT_ID);
      const base = {
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:15:00.000Z'),
        idempotencyKey: 'shared-key',
        requestedBy: 'test',
      };
      await insertHold(prisma, { ...base, tenantId: TEST_TENANT_ID, vehicleId: mine.id });
      await expect(
        insertHold(prisma, { ...base, tenantId: OTHER_TENANT_ID, vehicleId: theirs.id }),
      ).resolves.toMatchObject({ idempotencyKey: 'shared-key' });
    });

    it("findHoldByIdempotencyKey never returns another tenant's hold (tenant isolation)", async () => {
      const theirs = await seedVehicle(prisma, OTHER_TENANT_ID);
      await insertHold(prisma, {
        tenantId: OTHER_TENANT_ID,
        vehicleId: theirs.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:15:00.000Z'),
        idempotencyKey: 'their-key',
        requestedBy: 'test',
      });

      const crossTenantLookup = await findHoldByIdempotencyKey(prisma, TEST_TENANT_ID, 'their-key');
      expect(crossTenantLookup).toBeNull();
    });
  });

  describe('countOverlappingHolds', () => {
    it('counts a directly overlapping ACTIVE, non-expired hold', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const now = new Date('2026-10-01T00:00:00.000Z');
      await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() + HOUR_MS),
        idempotencyKey: 'k1',
        requestedBy: 'test',
      });

      const count = await countOverlappingHolds(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-06T10:00:00.000Z'),
        returnAt: new Date('2026-10-09T10:00:00.000Z'),
        bufferMs: 0,
        now,
      });
      expect(count).toBe(1);
    });

    it('does not count a hold outside the requested range with zero buffer', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const now = new Date('2026-10-01T00:00:00.000Z');
      await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() + HOUR_MS),
        idempotencyKey: 'k1',
        requestedBy: 'test',
      });

      const count = await countOverlappingHolds(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-09T10:00:00.000Z'),
        returnAt: new Date('2026-10-12T10:00:00.000Z'),
        bufferMs: 0,
        now,
      });
      expect(count).toBe(0);
    });

    it('a buffer extends the block across a back-to-back boundary ("calendar check with buffer")', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const now = new Date('2026-10-01T00:00:00.000Z');
      await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() + HOUR_MS),
        idempotencyKey: 'k1',
        requestedBy: 'test',
      });

      // Next pickup starts exactly when the previous return ends — no overlap without a buffer.
      const noBuffer = await countOverlappingHolds(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-08T10:00:00.000Z'),
        returnAt: new Date('2026-10-10T10:00:00.000Z'),
        bufferMs: 0,
        now,
      });
      expect(noBuffer).toBe(0);

      const withBuffer = await countOverlappingHolds(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-08T10:00:00.000Z'),
        returnAt: new Date('2026-10-10T10:00:00.000Z'),
        bufferMs: 2 * HOUR_MS,
        now,
      });
      expect(withBuffer).toBe(1);
    });

    it('excludes an ACTIVE hold whose expiresAt has already passed, even if never swept (lazy expiration / expired hold)', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const now = new Date('2026-10-01T00:00:00.000Z');
      await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() - 1), // already expired, status column still ACTIVE
        idempotencyKey: 'k1',
        requestedBy: 'test',
      });

      const count = await countOverlappingHolds(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-06T10:00:00.000Z'),
        returnAt: new Date('2026-10-09T10:00:00.000Z'),
        bufferMs: 0,
        now,
      });
      expect(count).toBe(0);
    });

    it('always counts a CONFIRMED hold, regardless of its (irrelevant) expiresAt', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const now = new Date('2026-10-01T00:00:00.000Z');
      const hold = await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() - 1),
        idempotencyKey: 'k1',
        requestedBy: 'test',
      });
      await updateHoldStatus(prisma, {
        tenantId: TEST_TENANT_ID,
        holdId: hold.id,
        expectedVersion: 0,
        nextStatus: 'CONFIRMED',
      });

      const count = await countOverlappingHolds(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-06T10:00:00.000Z'),
        returnAt: new Date('2026-10-09T10:00:00.000Z'),
        bufferMs: 0,
        now,
      });
      expect(count).toBe(1);
    });

    it('never counts a RELEASED or EXPIRED hold', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const now = new Date('2026-10-01T00:00:00.000Z');
      const released = await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() + HOUR_MS),
        idempotencyKey: 'k1',
        requestedBy: 'test',
      });
      await updateHoldStatus(prisma, {
        tenantId: TEST_TENANT_ID,
        holdId: released.id,
        expectedVersion: 0,
        nextStatus: 'RELEASED',
        releaseReason: 'customer cancelled',
      });
      const expired = await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() + HOUR_MS),
        idempotencyKey: 'k2',
        requestedBy: 'test',
      });
      await updateHoldStatus(prisma, {
        tenantId: TEST_TENANT_ID,
        holdId: expired.id,
        expectedVersion: 0,
        nextStatus: 'EXPIRED',
      });

      const count = await countOverlappingHolds(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-06T10:00:00.000Z'),
        returnAt: new Date('2026-10-09T10:00:00.000Z'),
        bufferMs: 0,
        now,
      });
      expect(count).toBe(0);
    });

    it('never counts another tenant\'s overlapping hold for the "same" vehicle id space (tenant isolation)', async () => {
      const mine = await seedVehicle(prisma, TEST_TENANT_ID);
      const theirs = await seedVehicle(prisma, OTHER_TENANT_ID);
      const now = new Date('2026-10-01T00:00:00.000Z');
      await insertHold(prisma, {
        tenantId: OTHER_TENANT_ID,
        vehicleId: theirs.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() + HOUR_MS),
        idempotencyKey: 'k1',
        requestedBy: 'test',
      });

      const count = await countOverlappingHolds(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: mine.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        bufferMs: 0,
        now,
      });
      expect(count).toBe(0);
    });
  });

  describe('updateHoldStatus (optimistic locking)', () => {
    it('succeeds and increments version when the expected version matches', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const hold = await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:15:00.000Z'),
        idempotencyKey: 'k1',
        requestedBy: 'test',
      });

      const affected = await updateHoldStatus(prisma, {
        tenantId: TEST_TENANT_ID,
        holdId: hold.id,
        expectedVersion: 0,
        nextStatus: 'CONFIRMED',
      });
      expect(affected).toBe(1);

      const reloaded = await findHoldById(prisma, TEST_TENANT_ID, hold.id);
      expect(reloaded?.status).toBe('CONFIRMED');
      expect(reloaded?.version).toBe(1);
    });

    it('affects zero rows when the expected version is stale (lost the race)', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const hold = await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:15:00.000Z'),
        idempotencyKey: 'k1',
        requestedBy: 'test',
      });

      // First writer wins and bumps the version to 1.
      const first = await updateHoldStatus(prisma, {
        tenantId: TEST_TENANT_ID,
        holdId: hold.id,
        expectedVersion: 0,
        nextStatus: 'CONFIRMED',
      });
      expect(first).toBe(1);

      // A second writer racing with the same stale (0) expected version loses.
      const second = await updateHoldStatus(prisma, {
        tenantId: TEST_TENANT_ID,
        holdId: hold.id,
        expectedVersion: 0,
        nextStatus: 'RELEASED',
        releaseReason: 'lost the race',
      });
      expect(second).toBe(0);

      const reloaded = await findHoldById(prisma, TEST_TENANT_ID, hold.id);
      expect(reloaded?.status).toBe('CONFIRMED'); // unchanged by the losing writer
    });

    it("never updates another tenant's hold (tenant isolation)", async () => {
      const theirs = await seedVehicle(prisma, OTHER_TENANT_ID);
      const hold = await insertHold(prisma, {
        tenantId: OTHER_TENANT_ID,
        vehicleId: theirs.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:15:00.000Z'),
        idempotencyKey: 'k1',
        requestedBy: 'test',
      });

      const affected = await updateHoldStatus(prisma, {
        tenantId: TEST_TENANT_ID,
        holdId: hold.id,
        expectedVersion: 0,
        nextStatus: 'RELEASED',
        releaseReason: 'attempted cross-tenant release',
      });
      expect(affected).toBe(0);

      const reloaded = await findHoldById(prisma, OTHER_TENANT_ID, hold.id);
      expect(reloaded?.status).toBe('ACTIVE');
    });
  });

  describe('expireDueHolds', () => {
    it('flips only ACTIVE holds whose expiresAt has passed, and reports the count', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const now = new Date('2026-10-01T00:00:00.000Z');
      const due = await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() - 1),
        idempotencyKey: 'due',
        requestedBy: 'test',
      });
      const notDue = await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-11-05T10:00:00.000Z'),
        returnAt: new Date('2026-11-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() + HOUR_MS),
        idempotencyKey: 'not-due',
        requestedBy: 'test',
      });
      const confirmed = await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-12-05T10:00:00.000Z'),
        returnAt: new Date('2026-12-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() - 1),
        idempotencyKey: 'confirmed',
        requestedBy: 'test',
      });
      await updateHoldStatus(prisma, {
        tenantId: TEST_TENANT_ID,
        holdId: confirmed.id,
        expectedVersion: 0,
        nextStatus: 'CONFIRMED',
      });

      const count = await expireDueHolds(prisma, now);
      expect(count).toBe(1);

      expect((await findHoldById(prisma, TEST_TENANT_ID, due.id))?.status).toBe('EXPIRED');
      expect((await findHoldById(prisma, TEST_TENANT_ID, notDue.id))?.status).toBe('ACTIVE');
      expect((await findHoldById(prisma, TEST_TENANT_ID, confirmed.id))?.status).toBe('CONFIRMED');
    });

    it('is idempotent — running it again over already-expired rows affects zero rows', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const now = new Date('2026-10-01T00:00:00.000Z');
      await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date(now.getTime() - 1),
        idempotencyKey: 'due',
        requestedBy: 'test',
      });

      expect(await expireDueHolds(prisma, now)).toBe(1);
      expect(await expireDueHolds(prisma, now)).toBe(0);
    });
  });

  describe('toDomainHold', () => {
    it('nulls out expiresAt once a hold is CONFIRMED (no TTL on a permanent block)', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const hold = await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:15:00.000Z'),
        idempotencyKey: 'k1',
        requestedBy: 'test',
      });
      await updateHoldStatus(prisma, {
        tenantId: TEST_TENANT_ID,
        holdId: hold.id,
        expectedVersion: 0,
        nextStatus: 'CONFIRMED',
      });
      const reloaded = await findHoldById(prisma, TEST_TENANT_ID, hold.id);
      expect(toDomainHold(reloaded!).expiresAt).toBeNull();
      expect(toDomainHold(reloaded!).status).toBe('CONFIRMED');
    });

    it('keeps expiresAt while ACTIVE', async () => {
      const vehicle = await seedVehicle(prisma, TEST_TENANT_ID);
      const hold = await insertHold(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: new Date('2026-10-05T10:00:00.000Z'),
        returnAt: new Date('2026-10-08T10:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:15:00.000Z'),
        idempotencyKey: 'k1',
        requestedBy: 'test',
      });
      expect(toDomainHold(hold).expiresAt).toBe('2026-10-01T00:15:00.000Z');
    });
  });
});
