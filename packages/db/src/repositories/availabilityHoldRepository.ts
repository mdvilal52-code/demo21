import {
  Prisma,
  type PrismaClient,
  type AvailabilityHold as PrismaAvailabilityHold,
} from '@prisma/client';
import { holdSchema, type Hold, type TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export function toDomainHold(row: PrismaAvailabilityHold): Hold {
  return holdSchema.parse({
    id: row.id,
    vehicleId: row.vehicleId,
    pickupDate: row.pickupAt.toISOString(),
    returnDate: row.returnAt.toISOString(),
    status: row.status,
    // No TTL once confirmed (a permanent calendar block); ACTIVE is the only status a TTL applies to.
    expiresAt: row.status === 'ACTIVE' ? row.expiresAt.toISOString() : null,
  });
}

export function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Pessimistic per-(tenant, vehicle) serialization: `pg_advisory_xact_lock`
 * is held for the rest of the enclosing transaction and released
 * automatically on commit/rollback — no separate unlock call, and no risk
 * of leaking a held lock if the transaction throws. `hashtext` collapses
 * the composite key to the bigint the lock function requires; a hash
 * collision between two different (tenantId, vehicleId) pairs would only
 * ever cause harmless extra serialization, never a correctness problem,
 * since the actual capacity decision below still re-reads real rows scoped
 * to the exact tenantId+vehicleId. Parameterized (not `$executeRawUnsafe`)
 * even though both inputs are pre-validated UUIDs — least-privilege
 * discipline applied uniformly, not conditionally on "this input happens
 * to be safe today".
 */
export async function acquireVehicleLock(
  tx: Prisma.TransactionClient,
  tenantId: TenantId,
  vehicleId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId} || ':' || ${vehicleId})::bigint)`;
}

export interface OverlapCountParams {
  tenantId: TenantId;
  vehicleId: string;
  pickupAt: Date;
  returnAt: Date;
  bufferMs: number;
  now: Date;
}

/**
 * Counts existing holds that block the requested [pickupAt, returnAt) range,
 * buffer included on both ends. Lazy expiration: an ACTIVE hold whose
 * `expiresAt` has already passed is excluded here even if the background
 * sweep (`expireDueHolds`) hasn't run yet — correctness never depends on
 * the sweep's timing, only on this query's own `now` parameter.
 */
export async function countOverlappingHolds(
  db: Executor,
  params: OverlapCountParams,
): Promise<number> {
  const bufferedStart = new Date(params.pickupAt.getTime() - params.bufferMs);
  const bufferedEnd = new Date(params.returnAt.getTime() + params.bufferMs);
  return db.availabilityHold.count({
    where: {
      tenantId: params.tenantId,
      vehicleId: params.vehicleId,
      pickupAt: { lt: bufferedEnd },
      returnAt: { gt: bufferedStart },
      OR: [{ status: 'CONFIRMED' }, { status: 'ACTIVE', expiresAt: { gt: params.now } }],
    },
  });
}

export async function findHoldByIdempotencyKey(
  db: Executor,
  tenantId: TenantId,
  idempotencyKey: string,
) {
  return db.availabilityHold.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
  });
}

export async function findHoldById(db: Executor, tenantId: TenantId, holdId: string) {
  return db.availabilityHold.findFirst({ where: { id: holdId, tenantId } });
}

export interface InsertHoldInput {
  tenantId: TenantId;
  vehicleId: string;
  pickupAt: Date;
  returnAt: Date;
  expiresAt: Date;
  idempotencyKey: string;
  requestedBy: string;
}

/** Caller (ReservationLockService) must already hold `acquireVehicleLock` and have re-verified capacity in this same transaction. */
export async function insertHold(db: Executor, input: InsertHoldInput) {
  return db.availabilityHold.create({
    data: {
      tenantId: input.tenantId,
      vehicleId: input.vehicleId,
      pickupAt: input.pickupAt,
      returnAt: input.returnAt,
      expiresAt: input.expiresAt,
      idempotencyKey: input.idempotencyKey,
      requestedBy: input.requestedBy,
      status: 'ACTIVE',
    },
  });
}

export interface UpdateHoldStatusParams {
  tenantId: TenantId;
  holdId: string;
  expectedVersion: number;
  nextStatus: 'CONFIRMED' | 'RELEASED' | 'EXPIRED';
  releaseReason?: string;
}

/**
 * Optimistic-locked state transition: 0 rows affected means the hold was
 * already modified (confirmed/released/expired) since the caller read its
 * `version` — the caller must treat that as a conflict, never retry blindly
 * with the same expected version.
 */
export async function updateHoldStatus(
  db: Executor,
  params: UpdateHoldStatusParams,
): Promise<number> {
  const result = await db.availabilityHold.updateMany({
    where: { id: params.holdId, tenantId: params.tenantId, version: params.expectedVersion },
    data: {
      status: params.nextStatus,
      version: { increment: 1 },
      ...(params.releaseReason !== undefined ? { releaseReason: params.releaseReason } : {}),
    },
  });
  return result.count;
}

/**
 * Housekeeping sweep only — never relied on for correctness (see
 * `countOverlappingHolds`'s lazy expiration). A single guarded bulk UPDATE
 * is safe to run concurrently or repeatedly: two overlapping sweeps just
 * both match a shrinking/empty set of rows, no lock needed.
 */
export async function expireDueHolds(db: Executor, now: Date): Promise<number> {
  const result = await db.availabilityHold.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lt: now } },
    data: { status: 'EXPIRED', version: { increment: 1 } },
  });
  return result.count;
}
