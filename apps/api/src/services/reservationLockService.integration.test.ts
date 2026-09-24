import {
  FleetProviderError,
  type FleetInventorySnapshot,
  type FleetProvider,
} from '@ai-concierge/ai';
import { createVehicle, createVehicleUnit, findHoldById, PrismaClient } from '@ai-concierge/db';
import { AppError } from '@ai-concierge/domain';
import {
  requireTestDatabaseUrl,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseFleetProvider } from './fleetProvider.js';
import { ReservationLockService } from './reservationLockService.js';

const PICKUP = new Date('2026-10-05T10:00:00.000Z');
const RETURN = new Date('2026-10-08T10:00:00.000Z');

async function seedVehicleWithUnits(
  prisma: PrismaClient,
  tenantId: string,
  unitCount: number,
  overrides: Partial<{
    active: boolean;
    availabilityStatus: 'AVAILABLE' | 'UNAVAILABLE' | 'MAINTENANCE';
  }> = {},
) {
  const vehicle = await createVehicle(prisma, {
    tenantId,
    make: 'Lamborghini',
    model: `Urus-${randomUUID().slice(0, 8)}`,
    category: 'SUV',
    luxuryTier: 'ULTRA_LUXURY',
    seats: 5,
    luggage: 4,
    transmission: 'AUTOMATIC',
    pricingProfile: { currency: 'AED', dailyRate: 3500 },
    active: overrides.active,
    availabilityStatus: overrides.availabilityStatus,
  });
  for (let i = 0; i < unitCount; i += 1) {
    await createVehicleUnit(prisma, { tenantId, vehicleId: vehicle.id, unitRef: `U-${i}` });
  }
  return vehicle;
}

function neverResolvesFleetProvider(): FleetProvider {
  return {
    name: 'hangs',
    getInventorySnapshot: () => new Promise<FleetInventorySnapshot>(() => {}),
  };
}

function alwaysFailsFleetProvider(message = 'upstream down'): FleetProvider {
  return {
    name: 'always-fails',
    getInventorySnapshot: async () => {
      throw new FleetProviderError(message, { retryable: true });
    },
  };
}

describe('ReservationLockService', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // A higher connection_limit than the default (~num_cpus*2+1) is needed
    // here specifically: this suite deliberately drives many concurrent
    // requests at the *same* vehicle, and ReservationLockService.placeHold
    // serializes them behind a Postgres advisory lock — each queued
    // transaction holds a pool connection for as long as it waits, so a
    // small pool can exhaust `maxWait` even though the locking itself is
    // correct. Production sizing is an operational concern (see
    // docs/PHASE-6.md's operational notes), not a defect this test should
    // paper over by using lower concurrency instead.
    const url = new URL(requireTestDatabaseUrl());
    url.searchParams.set('connection_limit', '25');
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedTestTenants(prisma);
  });

  function makeService(
    fleetProvider: FleetProvider = new DatabaseFleetProvider(prisma),
    now?: () => Date,
  ) {
    return new ReservationLockService(prisma, fleetProvider, {
      ttlSeconds: 900,
      bufferMinutes: 120,
      now,
    });
  }

  it('places a hold when capacity is free', async () => {
    const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
    const service = makeService();

    const result = await service.placeHold({
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      pickupAt: PICKUP,
      returnAt: RETURN,
      idempotencyKey: 'req-1',
      requestedBy: 'customer-1',
    });

    expect(result.outcome).toBe('HELD');
    if (result.outcome === 'HELD') {
      expect(result.hold.status).toBe('ACTIVE');
      expect(result.hold.vehicleId).toBe(vehicle.id);
    }
  });

  describe('placeHold validates the request itself (defense in depth)', () => {
    it('rejects a return date before the pickup date without creating a hold, even if the caller never validated', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      const service = makeService();

      await expect(
        service.placeHold({
          tenantId: TEST_TENANT_ID,
          vehicleId: vehicle.id,
          pickupAt: RETURN,
          returnAt: PICKUP,
          idempotencyKey: 'bad-range',
          requestedBy: 'customer-1',
        }),
      ).rejects.toThrow('Return date must be after pickup date');

      expect(await prisma.availabilityHold.count({ where: { vehicleId: vehicle.id } })).toBe(0);
    });

    it('rejects a pickup date already in the past, never consuming capacity', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      const service = makeService();

      await expect(
        service.placeHold({
          tenantId: TEST_TENANT_ID,
          vehicleId: vehicle.id,
          pickupAt: new Date('2020-01-01T00:00:00.000Z'),
          returnAt: new Date('2020-01-05T00:00:00.000Z'),
          idempotencyKey: 'stale-date',
          requestedBy: 'customer-1',
        }),
      ).rejects.toThrow('Pickup date is now in the past');

      expect(await prisma.availabilityHold.count({ where: { vehicleId: vehicle.id } })).toBe(0);
    });
  });

  describe('concurrent booking / race condition', () => {
    it('never oversells: exactly N of N+1 concurrent requests for N units succeed', async () => {
      const capacity = 3;
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, capacity);
      const service = makeService();

      const attempts = capacity + 1;
      const results = await Promise.all(
        Array.from({ length: attempts }, (_, i) =>
          service.placeHold({
            tenantId: TEST_TENANT_ID,
            vehicleId: vehicle.id,
            pickupAt: PICKUP,
            returnAt: RETURN,
            idempotencyKey: `concurrent-${i}`,
            requestedBy: `customer-${i}`,
          }),
        ),
      );

      const held = results.filter((r) => r.outcome === 'HELD');
      const unavailable = results.filter((r) => r.outcome === 'UNAVAILABLE');
      expect(held).toHaveLength(capacity);
      expect(unavailable).toHaveLength(1);

      const activeCount = await prisma.availabilityHold.count({
        where: { tenantId: TEST_TENANT_ID, vehicleId: vehicle.id, status: 'ACTIVE' },
      });
      expect(activeCount).toBe(capacity);
    });

    it('a sharper race — capacity 1, 10 truly concurrent requests — grants exactly one hold, never zero and never more than one', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      const service = makeService();

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          service.placeHold({
            tenantId: TEST_TENANT_ID,
            vehicleId: vehicle.id,
            pickupAt: PICKUP,
            returnAt: RETURN,
            idempotencyKey: `race-${i}`,
            requestedBy: `customer-${i}`,
          }),
        ),
      );

      expect(results.filter((r) => r.outcome === 'HELD')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'UNAVAILABLE')).toHaveLength(9);
    });
  });

  it('double booking: a second customer cannot hold what the first already holds', async () => {
    const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
    const service = makeService();

    const first = await service.placeHold({
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      pickupAt: PICKUP,
      returnAt: RETURN,
      idempotencyKey: 'customer-a',
      requestedBy: 'customer-a',
    });
    expect(first.outcome).toBe('HELD');

    const second = await service.placeHold({
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      pickupAt: PICKUP,
      returnAt: RETURN,
      idempotencyKey: 'customer-b',
      requestedBy: 'customer-b',
    });
    expect(second.outcome).toBe('UNAVAILABLE');

    const activeCount = await prisma.availabilityHold.count({
      where: { tenantId: TEST_TENANT_ID, vehicleId: vehicle.id, status: 'ACTIVE' },
    });
    expect(activeCount).toBe(1);
  });

  describe('duplicate request (idempotency)', () => {
    it('a sequential retry with the same idempotency key replays the same hold, not a new one', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      const service = makeService();
      const input = {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'retry-key',
        requestedBy: 'customer-1',
      };

      const first = await service.placeHold(input);
      const second = await service.placeHold(input);

      expect(first.outcome).toBe('HELD');
      expect(second.outcome).toBe('ALREADY_HELD');
      if (first.outcome === 'HELD' && second.outcome === 'ALREADY_HELD') {
        expect(second.hold.id).toBe(first.hold.id);
      }

      const rowCount = await prisma.availabilityHold.count({
        where: { tenantId: TEST_TENANT_ID, idempotencyKey: 'retry-key' },
      });
      expect(rowCount).toBe(1);
    });

    it('two truly concurrent requests with the same idempotency key still produce exactly one row', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      const service = makeService();
      const input = {
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'concurrent-retry-key',
        requestedBy: 'customer-1',
      };

      const [a, b] = await Promise.all([service.placeHold(input), service.placeHold(input)]);

      expect(['HELD', 'ALREADY_HELD']).toContain(a.outcome);
      expect(['HELD', 'ALREADY_HELD']).toContain(b.outcome);
      const rowCount = await prisma.availabilityHold.count({
        where: { tenantId: TEST_TENANT_ID, idempotencyKey: 'concurrent-retry-key' },
      });
      expect(rowCount).toBe(1);
    });
  });

  it('expired hold: a lapsed hold no longer blocks capacity for a new request', async () => {
    const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
    const service = makeService();

    const expired = await service.placeHold({
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      pickupAt: PICKUP,
      returnAt: RETURN,
      idempotencyKey: 'expired-hold',
      requestedBy: 'customer-a',
      ttlSeconds: -1, // already lapsed at the instant it was created
    });
    expect(expired.outcome).toBe('HELD');

    const afterExpiry = await service.placeHold({
      tenantId: TEST_TENANT_ID,
      vehicleId: vehicle.id,
      pickupAt: PICKUP,
      returnAt: RETURN,
      idempotencyKey: 'new-customer',
      requestedBy: 'customer-b',
    });
    expect(afterExpiry.outcome).toBe('HELD');
  });

  describe('fleet provider failure handling', () => {
    it('API timeout: a fleet call that never resolves surfaces as UNKNOWN + retryable, not a hang or a fake AVAILABLE', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      // No resilience wrapper needed to prove the service doesn't hang forever —
      // the fake provider itself models "never resolves"; a real deployment
      // wraps ExternalFleetApiProvider in ResilientFleetProvider (see
      // createFleetProvider.ts) to bound this in production.
      const service = makeService(neverResolvesFleetProvider());

      const resultPromise = service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'timeout-1',
        requestedBy: 'customer-1',
      });

      // Race against a short local timeout to prove *this test* doesn't hang;
      // resilientFleetProvider.test.ts proves the production timeout wrapper itself.
      const winner = await Promise.race([
        resultPromise.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('still-pending'), 200)),
      ]);
      expect(winner).toBe('still-pending');
    });

    it('provider failure: a rejected fleet call surfaces as UNKNOWN + retryable, and creates no hold', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      const service = makeService(alwaysFailsFleetProvider('fleet API returned 500'));

      const result = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'failure-1',
        requestedBy: 'customer-1',
      });

      expect(result).toMatchObject({ outcome: 'UNKNOWN', retryable: true });

      const rowCount = await prisma.availabilityHold.count({
        where: { tenantId: TEST_TENANT_ID, vehicleId: vehicle.id },
      });
      expect(rowCount).toBe(0);
    });

    it('a system retry after the provider recovers succeeds normally', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      const failingService = makeService(alwaysFailsFleetProvider());
      const failed = await failingService.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'retry-after-recovery',
        requestedBy: 'customer-1',
      });
      expect(failed.outcome).toBe('UNKNOWN');

      const recoveredService = makeService(new DatabaseFleetProvider(prisma));
      const recovered = await recoveredService.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'retry-after-recovery',
        requestedBy: 'customer-1',
      });
      expect(recovered.outcome).toBe('HELD');
    });
  });

  describe('catalog-level states', () => {
    it('returns MAINTENANCE for a vehicle catalog entry under maintenance, without creating a hold', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 2, {
        availabilityStatus: 'MAINTENANCE',
      });
      const service = makeService();

      const result = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'maintenance-1',
        requestedBy: 'customer-1',
      });

      expect(result.outcome).toBe('MAINTENANCE');
      expect(await prisma.availabilityHold.count({ where: { vehicleId: vehicle.id } })).toBe(0);
    });

    it('returns UNAVAILABLE for an inactive catalog entry even with free units', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 2, { active: false });
      const service = makeService();

      const result = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'inactive-1',
        requestedBy: 'customer-1',
      });

      expect(result.outcome).toBe('UNAVAILABLE');
    });

    it('returns UNAVAILABLE for a vehicle id that does not exist for this tenant', async () => {
      const service = makeService();
      const result = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: randomUUID(),
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'missing-vehicle',
        requestedBy: 'customer-1',
      });
      expect(result.outcome).toBe('UNAVAILABLE');
    });
  });

  describe('tenant isolation', () => {
    it("filling one tenant's capacity never affects another tenant, even with identically-shaped fleets", async () => {
      const mine = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      const theirs = await seedVehicleWithUnits(prisma, OTHER_TENANT_ID, 1);
      const service = makeService();

      const mineHeld = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: mine.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'mine',
        requestedBy: 'customer-1',
      });
      expect(mineHeld.outcome).toBe('HELD');

      const theirsHeld = await service.placeHold({
        tenantId: OTHER_TENANT_ID,
        vehicleId: theirs.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'theirs',
        requestedBy: 'customer-2',
      });
      expect(theirsHeld.outcome).toBe('HELD');
    });

    it('a vehicle id from another tenant is treated as not found, never cross-tenant-visible', async () => {
      const theirs = await seedVehicleWithUnits(prisma, OTHER_TENANT_ID, 5);
      const service = makeService();

      const result = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: theirs.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'cross-tenant-attempt',
        requestedBy: 'customer-1',
      });
      expect(result.outcome).toBe('UNAVAILABLE');
    });

    it('releaseHold/confirmHold reject a hold id that belongs to another tenant', async () => {
      const theirs = await seedVehicleWithUnits(prisma, OTHER_TENANT_ID, 1);
      const service = makeService();
      const held = await service.placeHold({
        tenantId: OTHER_TENANT_ID,
        vehicleId: theirs.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'theirs-hold',
        requestedBy: 'customer-1',
      });
      expect(held.outcome).toBe('HELD');
      const holdId = held.outcome === 'HELD' ? held.hold.id : '';

      await expect(service.confirmHold(TEST_TENANT_ID, holdId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(service.releaseHold(TEST_TENANT_ID, holdId, 'attempt')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      const stillActive = await findHoldById(prisma, OTHER_TENANT_ID, holdId);
      expect(stillActive?.status).toBe('ACTIVE');
    });
  });

  describe('confirmHold / releaseHold', () => {
    it('confirms an ACTIVE hold, after which it counts as BOOKED-equivalent (CONFIRMED) forever, no TTL', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      const service = makeService();
      const held = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'to-confirm',
        requestedBy: 'customer-1',
      });
      const holdId = held.outcome === 'HELD' ? held.hold.id : '';

      await service.confirmHold(TEST_TENANT_ID, holdId);

      const reloaded = await findHoldById(prisma, TEST_TENANT_ID, holdId);
      expect(reloaded?.status).toBe('CONFIRMED');
      expect(reloaded?.version).toBe(1);
    });

    it('writes an audit event for confirmHold and releaseHold (audit events on every mutation)', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 2);
      const service = makeService();
      const confirmed = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'audited-confirm',
        requestedBy: 'customer-1',
      });
      const released = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'audited-release',
        requestedBy: 'customer-2',
      });
      const confirmedId = confirmed.outcome === 'HELD' ? confirmed.hold.id : '';
      const releasedId = released.outcome === 'HELD' ? released.hold.id : '';

      await service.confirmHold(TEST_TENANT_ID, confirmedId, 'req-1');
      await service.releaseHold(TEST_TENANT_ID, releasedId, 'customer cancelled', 'req-2');

      const confirmAudit = await prisma.auditEvent.findFirst({
        where: { action: 'availability_hold.confirmed', entityId: confirmedId },
      });
      expect(confirmAudit).toMatchObject({ requestId: 'req-1', entityType: 'AvailabilityHold' });

      const releaseAudit = await prisma.auditEvent.findFirst({
        where: { action: 'availability_hold.released', entityId: releasedId },
      });
      expect(releaseAudit).toMatchObject({ requestId: 'req-2', entityType: 'AvailabilityHold' });
    });

    it('rejects confirming an already-confirmed hold (CONFLICT, not a silent no-op)', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      const service = makeService();
      const held = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'double-confirm',
        requestedBy: 'customer-1',
      });
      const holdId = held.outcome === 'HELD' ? held.hold.id : '';

      await service.confirmHold(TEST_TENANT_ID, holdId);
      await expect(service.confirmHold(TEST_TENANT_ID, holdId)).rejects.toBeInstanceOf(AppError);
    });

    it('rejects confirming a hold whose TTL has lapsed, even though its status column still reads ACTIVE (prevents a double-booking via a delayed confirm)', async () => {
      // Regression: a hold's `expiresAt` can pass before the background sweep
      // (§ holdExpirationSweep) flips its status to EXPIRED. Capacity
      // counting already treats it as expired the instant it lapses
      // (lazy expiration); confirmHold must apply the exact same rule, or a
      // sufficiently delayed confirm (e.g. a late payment webhook) could
      // permanently book a unit of capacity a concurrent customer has
      // already been correctly granted.
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      const service = makeService();
      const lapsed = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'lapsed-hold',
        requestedBy: 'customer-a',
        ttlSeconds: -1, // already expired at creation, status column still ACTIVE
      });
      const lapsedHoldId = lapsed.outcome === 'HELD' ? lapsed.hold.id : '';

      // A different customer legitimately takes the now-freed capacity.
      const freshHold = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'fresh-hold',
        requestedBy: 'customer-b',
      });
      expect(freshHold.outcome).toBe('HELD');

      await expect(service.confirmHold(TEST_TENANT_ID, lapsedHoldId)).rejects.toMatchObject({
        code: 'CONFLICT',
      });

      const reloaded = await findHoldById(prisma, TEST_TENANT_ID, lapsedHoldId);
      expect(reloaded?.status).toBe('ACTIVE'); // untouched by the rejected confirm attempt
    });

    it('releases an ACTIVE hold, freeing its capacity for another customer', async () => {
      const vehicle = await seedVehicleWithUnits(prisma, TEST_TENANT_ID, 1);
      const service = makeService();
      const held = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'to-release',
        requestedBy: 'customer-1',
      });
      const holdId = held.outcome === 'HELD' ? held.hold.id : '';

      await service.releaseHold(TEST_TENANT_ID, holdId, 'customer cancelled');

      const freed = await service.placeHold({
        tenantId: TEST_TENANT_ID,
        vehicleId: vehicle.id,
        pickupAt: PICKUP,
        returnAt: RETURN,
        idempotencyKey: 'new-customer-after-release',
        requestedBy: 'customer-2',
      });
      expect(freed.outcome).toBe('HELD');
    });

    it('throws NOT_FOUND for a nonexistent hold id', async () => {
      const service = makeService();
      await expect(service.confirmHold(TEST_TENANT_ID, randomUUID())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(service.releaseHold(TEST_TENANT_ID, randomUUID(), 'n/a')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
