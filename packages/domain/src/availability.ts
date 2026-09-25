import { z } from 'zod';

/**
 * Step 6 — Availability (MASTER-PLAN.md journey Step 6, `AVAILABILITY_CHECK`).
 * Unlike Steps 1-4, there is no raw customer text to parse here: input is a
 * conversation's already-resolved Step 3 vehicle + Step 2 dates. This file is
 * the contract between the provider abstractions (`AvailabilityProvider`,
 * `FleetProvider`), `ReservationLockService`, and the persistence/API layers.
 *
 * Never tell a customer a vehicle is available unless the authoritative
 * source (a successful, lock-protected `ReservationLockService.placeHold`)
 * confirms it — a plain read (`AvailabilityProvider.checkAvailability`) is a
 * preview only and must never be surfaced as a guarantee.
 */

/**
 * AVAILABLE/UNAVAILABLE/MAINTENANCE/UNKNOWN are read-only check outcomes.
 * HELD/BOOKED are the public projection of an actual hold's own lifecycle
 * (internal `HoldStatus` ACTIVE -> HELD, CONFIRMED -> BOOKED) once a hold
 * exists for this request — never returned from a check that didn't place
 * or look up a hold.
 */
export const InventoryStatus = {
  AVAILABLE: 'AVAILABLE',
  HELD: 'HELD',
  BOOKED: 'BOOKED',
  UNAVAILABLE: 'UNAVAILABLE',
  MAINTENANCE: 'MAINTENANCE',
  UNKNOWN: 'UNKNOWN',
} as const;

export const inventoryStatusSchema = z.enum([
  InventoryStatus.AVAILABLE,
  InventoryStatus.HELD,
  InventoryStatus.BOOKED,
  InventoryStatus.UNAVAILABLE,
  InventoryStatus.MAINTENANCE,
  InventoryStatus.UNKNOWN,
]);
export type InventoryStatusValue = z.infer<typeof inventoryStatusSchema>;

/** Internal hold lifecycle — see AvailabilityHold in schema.prisma for the full state-machine notes. */
export const HoldStatus = {
  ACTIVE: 'ACTIVE',
  CONFIRMED: 'CONFIRMED',
  RELEASED: 'RELEASED',
  EXPIRED: 'EXPIRED',
} as const;

export const holdStatusSchema = z.enum([
  HoldStatus.ACTIVE,
  HoldStatus.CONFIRMED,
  HoldStatus.RELEASED,
  HoldStatus.EXPIRED,
]);
export type HoldStatusValue = z.infer<typeof holdStatusSchema>;

/**
 * Precondition failures the Step 6 service throws as `AppError` before any
 * inventory check runs — distinct from the six `InventoryStatus` outcomes,
 * which describe the fleet itself, not "is this request even well-formed".
 */
export const AvailabilityErrorCode = {
  VEHICLE_NOT_RESOLVED: 'VEHICLE_NOT_RESOLVED',
  DATES_NOT_RESOLVED: 'DATES_NOT_RESOLVED',
  PICKUP_DATE_NOW_IN_PAST: 'PICKUP_DATE_NOW_IN_PAST',
  RETURN_BEFORE_OR_EQUAL_PICKUP: 'RETURN_BEFORE_OR_EQUAL_PICKUP',
} as const;

export const availabilityErrorCodeSchema = z.enum([
  AvailabilityErrorCode.VEHICLE_NOT_RESOLVED,
  AvailabilityErrorCode.DATES_NOT_RESOLVED,
  AvailabilityErrorCode.PICKUP_DATE_NOW_IN_PAST,
  AvailabilityErrorCode.RETURN_BEFORE_OR_EQUAL_PICKUP,
]);
export type AvailabilityErrorCodeValue = z.infer<typeof availabilityErrorCodeSchema>;

/** Public shape of a hold — no tenantId/version/idempotencyKey leaked (internal DB concerns). */
export const holdSchema = z.object({
  id: z.string().uuid(),
  vehicleId: z.string().uuid(),
  pickupDate: z.string().datetime(),
  returnDate: z.string().datetime(),
  status: holdStatusSchema,
  expiresAt: z.string().datetime().nullable(),
});
export type Hold = z.infer<typeof holdSchema>;

export const availabilityCheckResultSchema = z.object({
  status: inventoryStatusSchema,
  vehicleId: z.string().uuid(),
  pickupDate: z.string().datetime(),
  returnDate: z.string().datetime(),
  /** Set exactly when `status` is HELD or BOOKED. */
  hold: holdSchema.nullable(),
  /** Free-form provider name that answered this check (e.g. "database-fleet", "catalog") — for observability, not a closed enum. */
  source: z.string().min(1).max(100),
  /** Human-readable context for UNAVAILABLE/MAINTENANCE/UNKNOWN — never leaks internals. */
  reason: z.string().max(300).nullable(),
  /** True only for UNKNOWN — a provider/infrastructure failure, safe to retry. */
  retryable: z.boolean(),
  checkedAt: z.string().datetime(),
  modelMetadata: z.object({
    engine: z.string().min(1),
    version: z.string().min(1),
    deterministic: z.boolean(),
  }),
});
export type AvailabilityCheckResult = z.infer<typeof availabilityCheckResultSchema>;
