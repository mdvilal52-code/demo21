import { AvailabilityErrorCode, type AvailabilityErrorCodeValue } from '@ai-concierge/domain';
import type { AvailabilityCheckOutcome, AvailabilityProvider } from './availabilityProvider.js';

/**
 * Thrown for a request that is malformed or has gone stale since Step 2/3
 * resolved it — never for a real inventory outcome (that is
 * `InventoryStatus`, returned, not thrown). Distinct from Step 2's own
 * `PAST_DATE`/`RETURN_BEFORE_OR_EQUAL_PICKUP` checks: those ran when the
 * customer's message was first parsed, but time can pass before Step 6
 * runs (e.g. the customer took days to reply to a clarification), so the
 * same class of check must run again here against "now".
 */
export class AvailabilityRequestError extends Error {
  readonly code: AvailabilityErrorCodeValue;

  constructor(code: AvailabilityErrorCodeValue, message: string) {
    super(message);
    this.name = 'AvailabilityRequestError';
    this.code = code;
  }
}

export function validateAvailabilityRequest(pickupAt: Date, returnAt: Date, now: Date): void {
  if (returnAt.getTime() <= pickupAt.getTime()) {
    throw new AvailabilityRequestError(
      AvailabilityErrorCode.RETURN_BEFORE_OR_EQUAL_PICKUP,
      'Return date must be after pickup date',
    );
  }
  if (pickupAt.getTime() < now.getTime()) {
    throw new AvailabilityRequestError(
      AvailabilityErrorCode.PICKUP_DATE_NOW_IN_PAST,
      'Pickup date is now in the past; dates must be re-confirmed',
    );
  }
}

export interface AvailabilityCheckOrchestratorOptions {
  provider: AvailabilityProvider;
}

export interface CheckAvailabilityInput {
  tenantId: string;
  vehicleId: string;
  pickupAt: Date;
  returnAt: Date;
  now?: Date;
}

/**
 * Step 6 preview path: validates the request, then delegates to an injected
 * `AvailabilityProvider`. This is the non-committal read (see
 * availabilityProvider.ts's module doc) — the customer-facing hold
 * placement path (`ReservationLockService.placeHold`, apps/api) calls
 * `validateAvailabilityRequest` again itself and re-computes independently
 * under its own lock, never trusting this orchestrator's result as a
 * guarantee.
 *
 * Not wired into `AppContext`/any route in this phase — this phase's one
 * HTTP endpoint always goes straight to `ReservationLockService.placeHold`
 * (see availabilityService.ts), since only the authoritative claim may
 * answer a customer. This orchestrator exists, tested, as the seam a future
 * multi-vehicle preview (e.g. journey Step 7, "Alternatives") will call
 * without placing a hold against every candidate — deliberately not forced
 * into a live call site before that need exists.
 */
export class AvailabilityCheckOrchestrator {
  private readonly provider: AvailabilityProvider;

  constructor(options: AvailabilityCheckOrchestratorOptions) {
    this.provider = options.provider;
  }

  async check(input: CheckAvailabilityInput): Promise<AvailabilityCheckOutcome> {
    const now = input.now ?? new Date();
    validateAvailabilityRequest(input.pickupAt, input.returnAt, now);
    return this.provider.checkAvailability({
      tenantId: input.tenantId,
      vehicleId: input.vehicleId,
      pickupAt: input.pickupAt,
      returnAt: input.returnAt,
    });
  }
}
