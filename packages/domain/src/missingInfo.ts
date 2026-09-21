import { z } from 'zod';
import { normalizedLocationSchema } from './temporal.js';
import { vehicleSchema } from './vehicle.js';

/**
 * Step 4 — Ask Missing Information. Reads what Steps 1-3 already extracted
 * and verified for a conversation (never raw text re-parsed here) and
 * deterministically decides what's still needed before the booking can
 * proceed — MASTER-PLAN.md journey Step 4, `COLLECTING_MISSING_INFO`,
 * "loop until complete or timeout" (`MISSING_INFO_TIMEOUT_HOURS`).
 */

export const RequiredField = {
  PICKUP_DATE: 'PICKUP_DATE',
  RETURN_DATE: 'RETURN_DATE',
  PICKUP_LOCATION: 'PICKUP_LOCATION',
  VEHICLE: 'VEHICLE',
} as const;

export const requiredFieldSchema = z.enum([
  RequiredField.PICKUP_DATE,
  RequiredField.RETURN_DATE,
  RequiredField.PICKUP_LOCATION,
  RequiredField.VEHICLE,
]);
export type RequiredFieldValue = z.infer<typeof requiredFieldSchema>;

/**
 * Why a required field isn't resolved yet: never mentioned at all, mentioned
 * but Steps 2-3 couldn't confidently resolve it, or resolved but rejected by
 * deterministic business validation (e.g. a past date, an inactive vehicle).
 */
export const MissingFieldReason = {
  NOT_PROVIDED: 'NOT_PROVIDED',
  AMBIGUOUS: 'AMBIGUOUS',
  INVALID: 'INVALID',
} as const;

export const missingFieldReasonSchema = z.enum([
  MissingFieldReason.NOT_PROVIDED,
  MissingFieldReason.AMBIGUOUS,
  MissingFieldReason.INVALID,
]);
export type MissingFieldReasonValue = z.infer<typeof missingFieldReasonSchema>;

export const missingFieldSchema = z.object({
  field: requiredFieldSchema,
  reason: missingFieldReasonSchema,
  /** The underlying Step 2/3 ambiguity/validation-error message, when one exists. */
  detail: z.string().max(300).optional(),
});
export type MissingField = z.infer<typeof missingFieldSchema>;

export const MissingInfoStatus = {
  /** All required fields resolved. */
  COMPLETE: 'COMPLETE',
  /** Something is still missing and the 24h window hasn't elapsed. */
  NEEDS_INFO: 'NEEDS_INFO',
  /** Something is still missing and the 24h window has elapsed. */
  EXPIRED: 'EXPIRED',
  /** The conversation's intent isn't a booking request, so this check doesn't apply. */
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  /** The customer explicitly cancelled a booking that had real progress collected. */
  CANCELLED: 'CANCELLED',
} as const;

export const missingInfoStatusSchema = z.enum([
  MissingInfoStatus.COMPLETE,
  MissingInfoStatus.NEEDS_INFO,
  MissingInfoStatus.EXPIRED,
  MissingInfoStatus.NOT_APPLICABLE,
  MissingInfoStatus.CANCELLED,
]);
export type MissingInfoStatusValue = z.infer<typeof missingInfoStatusSchema>;

/** MASTER-PLAN.md journey Step 4: "timeout 24h -> EXPIRED". */
export const MISSING_INFO_TIMEOUT_HOURS = 24;

/** A read-through summary of what Steps 1-3 have resolved so far — never a new AI guess. */
export const collectedBookingInfoSchema = z.object({
  pickupDate: z.string().datetime().nullable(),
  returnDate: z.string().datetime().nullable(),
  pickupLocation: normalizedLocationSchema.nullable(),
  dropoffLocation: normalizedLocationSchema.nullable(),
  vehicle: vehicleSchema.nullable(),
});
export type CollectedBookingInfo = z.infer<typeof collectedBookingInfoSchema>;

export const missingInfoFlagsSchema = z.object({
  /** True if Step 1, 2, or 3 flagged prompt injection anywhere in this conversation so far. */
  promptInjectionDetectedAnywhere: z.boolean(),
});

export const missingInfoResultSchema = z.object({
  status: missingInfoStatusSchema,
  collected: collectedBookingInfoSchema,
  missingFields: z.array(missingFieldSchema),
  /** A single deterministic, combined clarification question; null unless status is NEEDS_INFO. */
  clarificationPrompt: z.string().min(1).max(500).nullable(),
  expiresAt: z.string().datetime(),
  flags: missingInfoFlagsSchema,
  modelMetadata: z.object({
    engine: z.string().min(1),
    version: z.string().min(1),
    deterministic: z.boolean(),
  }),
});
export type MissingInfoResult = z.infer<typeof missingInfoResultSchema>;
