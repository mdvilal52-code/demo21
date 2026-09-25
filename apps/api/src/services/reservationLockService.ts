import { type FleetProvider, validateAvailabilityRequest } from '@ai-concierge/ai';
import {
  acquireVehicleLock,
  findHoldByIdempotencyKey,
  insertHold,
  isUniqueConstraintViolation,
  PrismaAuditWriter,
  toDomainHold,
  updateHoldStatus,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, type Hold, type TenantId } from '@ai-concierge/domain';
import { evaluateInventoryStatus } from './inventoryStatusEvaluator.js';

export interface PlaceHoldInput {
  tenantId: TenantId;
  vehicleId: string;
  pickupAt: Date;
  returnAt: Date;
  idempotencyKey: string;
  requestedBy: string;
  /** Overridable per call for tests; production callers rely on the service-level default. */
  ttlSeconds?: number;
}

export type PlaceHoldResult =
  | { outcome: 'HELD'; hold: Hold; source: string }
  | { outcome: 'ALREADY_HELD'; hold: Hold; source: string }
  | { outcome: 'UNAVAILABLE'; source: string }
  | { outcome: 'MAINTENANCE'; source: string }
  | { outcome: 'UNKNOWN'; reason: string; retryable: boolean; source: string };

export interface ReservationLockServiceOptions {
  ttlSeconds: number;
  bufferMinutes: number;
  /** Injectable clock for expiry tests — defaults to the real wall clock. */
  now?: () => Date;
}

/**
 * The one class that actually claims capacity. "Never tell customer a
 * vehicle is available unless authoritative source confirms it" means every
 * customer-facing answer must come from `placeHold`, never from
 * `AvailabilityProvider.checkAvailability` alone (see that interface's doc
 * in packages/ai/src/step6/availabilityProvider.ts). `placeHold` and
 * `AvailabilityProvider` share the exact same status computation
 * (`evaluateInventoryStatus`) so the two can never silently disagree on what
 * "available" means — only whether a lock was held and a row written.
 *
 * Concurrency model: `placeHold` acquires a Postgres advisory lock scoped to
 * (tenantId, vehicleId) before recomputing capacity — pessimistic
 * serialization of the scarce resource itself, so two concurrent requests
 * for the same vehicle can never both succeed past capacity. `releaseHold`/
 * `confirmHold` instead use optimistic locking (`AvailabilityHold.version`):
 * a hold, once created, is only touched by whoever supplies its current
 * version, so two racing state transitions on the *same* hold (e.g. an
 * expiry sweep racing a manual confirm) can't silently clobber each other —
 * the loser sees 0 rows affected and gets a `CONFLICT`, never a
 * successful-looking no-op. Pessimistic locking guards the shared, scarce
 * resource (capacity); optimistic locking guards a single row nobody else
 * should be contending for in the common case — "where appropriate" means
 * matching the lock strategy to which of those two shapes applies.
 */
export class ReservationLockService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly fleetProvider: FleetProvider,
    private readonly options: ReservationLockServiceOptions,
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  /**
   * Idempotent: a retried request with the same `idempotencyKey` replays the
   * existing hold rather than consuming capacity twice (checked both before
   * the lock, as a fast path, and again on a unique-constraint race inside
   * it — see the insert's catch block). Every other branch re-derives status
   * from fresh reads taken *after* the advisory lock is held, never from a
   * caller-supplied belief about availability. Validates the request itself
   * (never trusts an earlier caller, e.g. `availabilityService.ts`, to have
   * already done so) — the sole authoritative entry point must hold even if
   * called directly by a future, different caller.
   */
  async placeHold(input: PlaceHoldInput): Promise<PlaceHoldResult> {
    validateAvailabilityRequest(input.pickupAt, input.returnAt, this.now());

    const existing = await findHoldByIdempotencyKey(
      this.prisma,
      input.tenantId,
      input.idempotencyKey,
    );
    if (existing) {
      return { outcome: 'ALREADY_HELD', hold: toDomainHold(existing), source: 'idempotent-replay' };
    }

    return this.prisma.$transaction(
      async (tx): Promise<PlaceHoldResult> => {
        await acquireVehicleLock(tx, input.tenantId, input.vehicleId);

        // Re-check *inside* the lock: the pre-lock check above is a fast-path
        // optimization only and is itself racy — two concurrent callers with
        // the *same* idempotencyKey can both miss it and both reach this
        // transaction. Whichever acquires the advisory lock second must
        // recognize the first one's now-committed row as *its own* request
        // replaying, not as a competing reservation eating capacity (which
        // would otherwise wrongly reject a duplicate/retried request as
        // UNAVAILABLE once capacity is tight — caught by this phase's own
        // concurrent-duplicate-request test).
        const racedExisting = await findHoldByIdempotencyKey(
          tx,
          input.tenantId,
          input.idempotencyKey,
        );
        if (racedExisting) {
          return {
            outcome: 'ALREADY_HELD',
            hold: toDomainHold(racedExisting),
            source: 'idempotent-replay',
          };
        }

        const now = this.now();
        const evaluation = await evaluateInventoryStatus(tx, this.fleetProvider, {
          tenantId: input.tenantId,
          vehicleId: input.vehicleId,
          pickupAt: input.pickupAt,
          returnAt: input.returnAt,
          bufferMinutes: this.options.bufferMinutes,
          now,
        });

        if (evaluation.status === 'UNKNOWN') {
          return {
            outcome: 'UNKNOWN',
            reason: evaluation.reason ?? 'Fleet provider failed',
            retryable: evaluation.retryable,
            source: evaluation.source,
          };
        }
        if (evaluation.status !== 'AVAILABLE') {
          return { outcome: evaluation.status, source: evaluation.source };
        }

        const ttlSeconds = input.ttlSeconds ?? this.options.ttlSeconds;
        const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

        try {
          const created = await insertHold(tx, {
            tenantId: input.tenantId,
            vehicleId: input.vehicleId,
            pickupAt: input.pickupAt,
            returnAt: input.returnAt,
            expiresAt,
            idempotencyKey: input.idempotencyKey,
            requestedBy: input.requestedBy,
          });
          return { outcome: 'HELD', hold: toDomainHold(created), source: evaluation.source };
        } catch (error) {
          if (isUniqueConstraintViolation(error)) {
            const raced = await findHoldByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
            if (raced) {
              return {
                outcome: 'ALREADY_HELD',
                hold: toDomainHold(raced),
                source: 'idempotent-replay',
              };
            }
          }
          throw error;
        }
      },
      // Acquiring a per-vehicle lock under real contention is *expected* to
      // queue — the Prisma client defaults (2s to acquire a pool connection,
      // 5s transaction budget) are tuned for uncontended transactions, not a
      // deliberately-serialized hot resource; a request that has to wait
      // behind several others for the same vehicle is not a failure.
      { maxWait: 10_000, timeout: 10_000 },
    );
  }

  async releaseHold(
    tenantId: TenantId,
    holdId: string,
    reason: string,
    requestId?: string,
  ): Promise<void> {
    const hold = await this.prisma.availabilityHold.findFirst({ where: { id: holdId, tenantId } });
    if (!hold) {
      throw new AppError('NOT_FOUND', 'Hold not found');
    }
    await this.prisma.$transaction(async (tx) => {
      const affected = await updateHoldStatus(tx, {
        tenantId,
        holdId,
        expectedVersion: hold.version,
        nextStatus: 'RELEASED',
        releaseReason: reason,
      });
      if (affected === 0) {
        throw new AppError('CONFLICT', 'Hold was already modified by another operation');
      }
      await new PrismaAuditWriter(tx).record({
        tenantId,
        actor: 'system:reservation-lock-service',
        action: 'availability_hold.released',
        entityType: 'AvailabilityHold',
        entityId: holdId,
        before: { status: hold.status },
        after: { status: 'RELEASED', reason },
        requestId,
      });
    });
  }

  /**
   * Rejects confirming a hold whose TTL has already lapsed, even though its
   * `status` column still reads ACTIVE (the background sweep hasn't run
   * yet) — the same lazy-expiration consistency
   * `availabilityHoldRepository.countOverlappingHolds` already applies when
   * *counting* capacity. Without this check, a hold that a concurrent
   * `placeHold` has already started ignoring (because it correctly no
   * longer counts toward capacity) could still be confirmed by a
   * sufficiently delayed caller — e.g. a late payment webhook — creating two
   * permanent (CONFIRMED) holds against the same unit of capacity, exactly
   * the oversell this service exists to prevent.
   */
  async confirmHold(tenantId: TenantId, holdId: string, requestId?: string): Promise<void> {
    const hold = await this.prisma.availabilityHold.findFirst({ where: { id: holdId, tenantId } });
    if (!hold) {
      throw new AppError('NOT_FOUND', 'Hold not found');
    }
    if (hold.status !== 'ACTIVE') {
      throw new AppError('CONFLICT', `Cannot confirm a hold in status ${hold.status}`);
    }
    if (hold.expiresAt.getTime() <= this.now().getTime()) {
      throw new AppError('CONFLICT', 'Cannot confirm a hold that has already expired');
    }
    await this.prisma.$transaction(async (tx) => {
      const affected = await updateHoldStatus(tx, {
        tenantId,
        holdId,
        expectedVersion: hold.version,
        nextStatus: 'CONFIRMED',
      });
      if (affected === 0) {
        throw new AppError('CONFLICT', 'Hold was already modified by another operation');
      }
      await new PrismaAuditWriter(tx).record({
        tenantId,
        actor: 'system:reservation-lock-service',
        action: 'availability_hold.confirmed',
        entityType: 'AvailabilityHold',
        entityId: holdId,
        before: { status: 'ACTIVE' },
        after: { status: 'CONFIRMED' },
        requestId,
      });
    });
  }
}
