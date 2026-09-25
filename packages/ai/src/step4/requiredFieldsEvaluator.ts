import {
  MissingInfoStatus,
  MissingFieldReason,
  MISSING_INFO_TIMEOUT_HOURS,
  RequiredField,
  type Ambiguity,
  type CollectedBookingInfo,
  type MissingField,
  type MissingInfoStatusValue,
  type NormalizedLocation,
  type Vehicle,
  type VehicleAmbiguity,
  type VehicleDeterminationStatusValue,
  type VehicleValidationError,
  type ValidationIssue,
} from '@ai-concierge/domain';

/**
 * The narrow slice of a Step 1 IntentRecord this phase needs — never the
 * full result, so this stays trivial to construct from a stored DB row.
 */
export interface IntentSnapshot {
  intentType: string;
  promptInjectionDetected: boolean;
}

/** The narrow slice of a Step 2 DateLocationExtraction this phase needs. */
export interface DateLocationSnapshot {
  pickupDate: string | null;
  returnDate: string | null;
  pickupLocation: NormalizedLocation | null;
  dropoffLocation: NormalizedLocation | null;
  ambiguities: Ambiguity[];
  validationErrors: ValidationIssue[];
  promptInjectionDetected: boolean;
}

/** The narrow slice of a Step 3 VehicleDetermination this phase needs. */
export interface VehicleSnapshot {
  status: VehicleDeterminationStatusValue;
  resolvedVehicle: Vehicle | null;
  ambiguities: VehicleAmbiguity[];
  validationErrors: VehicleValidationError[];
  promptInjectionDetected: boolean;
}

export interface RequiredFieldsEvaluationInput {
  /** Null when Step 1 hasn't recognized an intent for this message (shouldn't normally happen). */
  intent: IntentSnapshot | null;
  /** Null when Step 2 has never been run for this conversation's message. */
  dateLocation: DateLocationSnapshot | null;
  /** Null when Step 3 has never been run for this conversation's message. */
  vehicle: VehicleSnapshot | null;
  /** The conversation's own creation time — the "loop until ... timeout" clock starts here. */
  conversationCreatedAt: Date;
  now: Date;
}

export interface RequiredFieldsEvaluation {
  status: MissingInfoStatusValue;
  collected: CollectedBookingInfo;
  missingFields: MissingField[];
  promptInjectionDetectedAnywhere: boolean;
}

function evaluateDateField(
  field: 'PICKUP_DATE' | 'RETURN_DATE',
  validationField: 'pickupDate' | 'returnDate',
  value: string | null,
  dateLocation: DateLocationSnapshot | null,
): MissingField | null {
  if (value) return null;
  const invalid = dateLocation?.validationErrors.find(
    (issue) => issue.field === validationField && issue.severity === 'ERROR',
  );
  if (invalid) return { field, reason: MissingFieldReason.INVALID, detail: invalid.message };
  const ambiguous = dateLocation?.ambiguities.find((a) => a.field === validationField);
  if (ambiguous) {
    return { field, reason: MissingFieldReason.AMBIGUOUS, detail: ambiguous.message };
  }
  return { field, reason: MissingFieldReason.NOT_PROVIDED };
}

function evaluatePickupLocation(dateLocation: DateLocationSnapshot | null): MissingField | null {
  if (dateLocation?.pickupLocation) return null;
  const invalid = dateLocation?.validationErrors.find(
    (issue) => issue.field === 'pickupLocation' && issue.severity === 'ERROR',
  );
  if (invalid) {
    return {
      field: RequiredField.PICKUP_LOCATION,
      reason: MissingFieldReason.INVALID,
      detail: invalid.message,
    };
  }
  const ambiguous = dateLocation?.ambiguities.find((a) => a.field === 'pickupLocation');
  if (ambiguous) {
    return {
      field: RequiredField.PICKUP_LOCATION,
      reason: MissingFieldReason.AMBIGUOUS,
      detail: ambiguous.message,
    };
  }
  return { field: RequiredField.PICKUP_LOCATION, reason: MissingFieldReason.NOT_PROVIDED };
}

/**
 * True once real progress exists for this conversation — a resolved
 * vehicle, or a resolved pickup/return date, or a resolved pickup location
 * — regardless of what *this specific* message classified as. Steps 2-3
 * re-run against the whole accumulated transcript every turn (see
 * `vehicleService.ts`/`dateLocationService.ts`), so this reflects the
 * conversation's cumulative progress, not just the latest message.
 *
 * Without this, a side question mid-booking (e.g. "what documents do I
 * need?", classified DOCUMENT_REQUEST — a real classification this system
 * has no dedicated reply for) would hit the `intentType !== BOOKING_REQUEST`
 * gate below, discard everything already collected, and reply with the
 * generic "let us know if you'd like to book" text as if no booking were
 * underway — exactly the "moves to an unrelated next step" / "loses
 * already-provided data" failure this evaluator exists to prevent. Once
 * real progress exists, evaluation proceeds and (per the fields still
 * outstanding) re-asks the same pending question instead.
 */
function hasExistingProgress(
  dateLocation: DateLocationSnapshot | null,
  vehicle: VehicleSnapshot | null,
): boolean {
  return Boolean(
    dateLocation?.pickupDate ||
    dateLocation?.returnDate ||
    dateLocation?.pickupLocation ||
    (vehicle?.status === 'RESOLVED' && vehicle.resolvedVehicle),
  );
}

function evaluateVehicle(vehicle: VehicleSnapshot | null): MissingField | null {
  if (vehicle?.status === 'RESOLVED' && vehicle.resolvedVehicle) return null;
  if (vehicle?.status === 'UNSUPPORTED') {
    const invalid = vehicle.validationErrors[0];
    return {
      field: RequiredField.VEHICLE,
      reason: MissingFieldReason.INVALID,
      ...(invalid ? { detail: invalid.message } : {}),
    };
  }
  if (vehicle?.status === 'NEEDS_CLARIFICATION') {
    const ambiguous = vehicle.ambiguities[0];
    return {
      field: RequiredField.VEHICLE,
      reason: MissingFieldReason.AMBIGUOUS,
      ...(ambiguous ? { detail: ambiguous.message } : {}),
    };
  }
  return { field: RequiredField.VEHICLE, reason: MissingFieldReason.NOT_PROVIDED };
}

/**
 * The deterministic core of Step 4: given whatever Steps 1-3 have already
 * resolved and verified for a conversation, decides what's still missing.
 * Never re-parses raw text — every signal here already went through its own
 * step's "AI proposes, deterministic domain logic verifies" pipeline.
 */
export class RequiredFieldsEvaluator {
  evaluate(input: RequiredFieldsEvaluationInput): RequiredFieldsEvaluation {
    const promptInjectionDetectedAnywhere = Boolean(
      input.intent?.promptInjectionDetected ||
      input.dateLocation?.promptInjectionDetected ||
      input.vehicle?.promptInjectionDetected,
    );

    const collected: CollectedBookingInfo = {
      pickupDate: input.dateLocation?.pickupDate ?? null,
      returnDate: input.dateLocation?.returnDate ?? null,
      pickupLocation: input.dateLocation?.pickupLocation ?? null,
      dropoffLocation: input.dateLocation?.dropoffLocation ?? null,
      vehicle: input.vehicle?.resolvedVehicle ?? null,
    };

    const isBookingRequest = input.intent?.intentType === 'BOOKING_REQUEST';
    const hasProgress = hasExistingProgress(input.dateLocation, input.vehicle);

    // Cancelling only means something once there's a booking in progress to
    // cancel; checked ahead of the COMPLETE/NEEDS_INFO evaluation below so a
    // cancellation always wins over whatever was already collected, even a
    // fully COMPLETE booking.
    if (input.intent?.intentType === 'CANCEL_REQUEST' && hasProgress) {
      return {
        status: MissingInfoStatus.CANCELLED,
        collected,
        missingFields: [],
        promptInjectionDetectedAnywhere,
      };
    }

    if (!isBookingRequest && !hasProgress) {
      return {
        status: MissingInfoStatus.NOT_APPLICABLE,
        collected,
        missingFields: [],
        promptInjectionDetectedAnywhere,
      };
    }

    const missingFields = [
      evaluateDateField('PICKUP_DATE', 'pickupDate', collected.pickupDate, input.dateLocation),
      evaluateDateField('RETURN_DATE', 'returnDate', collected.returnDate, input.dateLocation),
      evaluatePickupLocation(input.dateLocation),
      evaluateVehicle(input.vehicle),
    ].filter((field): field is MissingField => field !== null);

    if (missingFields.length === 0) {
      return {
        status: MissingInfoStatus.COMPLETE,
        collected,
        missingFields: [],
        promptInjectionDetectedAnywhere,
      };
    }

    const hoursSinceCreated =
      (input.now.getTime() - input.conversationCreatedAt.getTime()) / (1000 * 60 * 60);
    const status =
      hoursSinceCreated > MISSING_INFO_TIMEOUT_HOURS
        ? MissingInfoStatus.EXPIRED
        : MissingInfoStatus.NEEDS_INFO;

    return { status, collected, missingFields, promptInjectionDetectedAnywhere };
  }
}
