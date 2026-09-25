import type { InventoryStatusValue } from '@ai-concierge/domain';

export interface AvailabilityCheckQuery {
  tenantId: string;
  vehicleId: string;
  pickupAt: Date;
  returnAt: Date;
}

/** A non-committal read — never returns HELD/BOOKED, never creates a hold. See module doc below. */
export interface AvailabilityCheckOutcome {
  status: Exclude<InventoryStatusValue, 'HELD' | 'BOOKED'>;
  source: string;
  reason: string | null;
  retryable: boolean;
}

/**
 * Seam for a non-committal "what does the fleet look like right now" read —
 * e.g. Step 7 (Alternatives, a later phase) scanning several candidate
 * vehicles without placing a hold against each one. Its result is a preview
 * only: "Never tell customer a vehicle is available unless authoritative
 * source confirms it" means a customer-facing answer must always come from
 * `ReservationLockService.placeHold` (the lock-protected claim), never from
 * this interface alone, however recent the read.
 */
export interface AvailabilityProvider {
  readonly name: string;
  checkAvailability(query: AvailabilityCheckQuery): Promise<AvailabilityCheckOutcome>;
}
