/**
 * Pure, zero-I/O inventory logic — the same "pure logic, deterministic
 * verifier" shape as Step 2's `TemporalValidationService` / Step 3's
 * `VehicleValidationService`. Both `AvailabilityProvider` (read-only preview)
 * and `ReservationLockService.placeHold` (the authoritative, lock-protected
 * claim) call this exact function with fresh inputs — the only difference
 * between a preview and a guarantee is *when* and *under what lock* the
 * inputs were gathered, never the decision logic itself.
 */

export type CatalogAvailabilityStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'MAINTENANCE';

export interface InventoryComputationInput {
  catalogAvailabilityStatus: CatalogAvailabilityStatus;
  catalogActive: boolean;
  activeUnits: number;
  maintenanceUnits: number;
  /** Count of existing holds (ACTIVE-and-not-expired, or CONFIRMED) that overlap the requested range, buffer included. */
  overlappingCount: number;
}

export type ComputedInventoryStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'MAINTENANCE';

/**
 * Never returns HELD/BOOKED/UNKNOWN — those are, respectively, the outcome
 * of actually placing a hold (a side effect this function has none of) and
 * the outcome of a provider failure (handled by the caller before this
 * function is even reached).
 */
export function computeInventoryStatus(input: InventoryComputationInput): ComputedInventoryStatus {
  if (!input.catalogActive || input.catalogAvailabilityStatus === 'UNAVAILABLE') {
    return 'UNAVAILABLE';
  }
  if (input.catalogAvailabilityStatus === 'MAINTENANCE') {
    return 'MAINTENANCE';
  }
  if (input.activeUnits <= 0) {
    return input.maintenanceUnits > 0 ? 'MAINTENANCE' : 'UNAVAILABLE';
  }
  if (input.overlappingCount >= input.activeUnits) {
    return 'UNAVAILABLE';
  }
  return 'AVAILABLE';
}

/**
 * Two half-open ranges [aStart,aEnd) / [bStart,bEnd) overlap once each is
 * padded by `bufferMs` on both ends — MASTER-PLAN.md's "calendar check with
 * buffer" (turnaround time between a return and the next pickup, e.g.
 * cleaning/inspection). Pure instant arithmetic (`getTime()`), so it is
 * correct regardless of which IANA zone/offset the inputs were originally
 * expressed in — timezone correctness for this comparison is "always
 * compare absolute instants", not zone-aware date math.
 */
export function rangesOverlapWithBuffer(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
  bufferMs: number,
): boolean {
  return (
    aStart.getTime() < bEnd.getTime() + bufferMs && bStart.getTime() < aEnd.getTime() + bufferMs
  );
}
