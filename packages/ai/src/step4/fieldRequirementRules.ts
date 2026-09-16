import {
  MissingInfoFieldKey,
  type ChannelValue,
  type LocationTypeValue,
  type MissingInfoFieldKeyValue,
  type NormalizedLocation,
} from '@ai-concierge/domain';

export interface FieldRequirementContext {
  pickupLocation: NormalizedLocation | null;
  dropoffLocation: NormalizedLocation | null;
  channel: ChannelValue;
  /** True when Step 1's entity extraction already captured a real driverRequired value. */
  driverRequirementKnownFromStep1: boolean;
}

/** Precise enough to deliver/collect a vehicle without asking for a further address. */
const PRECISE_LOCATION_TYPES = new Set<LocationTypeValue>(['HOTEL', 'ADDRESS', 'AIRPORT']);

/**
 * The sole authority on whether a field is even applicable — every "already
 * supplied" / "unnecessary" decision for a field's *requiredness* is made
 * here, from real Step 1-3 data only, never guessed.
 */
export function isFieldRequired(
  field: MissingInfoFieldKeyValue,
  context: FieldRequirementContext,
): boolean {
  switch (field) {
    case MissingInfoFieldKey.FLIGHT_NUMBER:
      // Only relevant when the customer is actually being picked up at the airport.
      return context.pickupLocation?.locationType === 'AIRPORT';
    case MissingInfoFieldKey.DROPOFF_ADDRESS:
      // Step 2 may already have resolved a precise enough drop-off point.
      return (
        !context.dropoffLocation ||
        !PRECISE_LOCATION_TYPES.has(context.dropoffLocation.locationType)
      );
    case MissingInfoFieldKey.PICKUP_TIME:
      // Step 2 never extracts a real clock time (always a fixed default hour).
      return true;
    case MissingInfoFieldKey.DRIVER_REQUIREMENT:
      return !context.driverRequirementKnownFromStep1;
    case MissingInfoFieldKey.CONTACT_DETAILS:
      // WhatsApp/Email channel identity (customerRef) already is a reachable contact.
      return context.channel === 'WEB';
    case MissingInfoFieldKey.SPECIAL_REQUESTS:
      return false;
    default:
      return false;
  }
}
