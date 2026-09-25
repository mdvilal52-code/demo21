import { z } from 'zod';
import { vehicleSchema } from './vehicle.js';

/**
 * Step 7 — Alternatives (MASTER-PLAN.md journey Step 7, `OFFERING_ALTERNATIVES`,
 * "if unavailable: nearest dates / similar class / upgrade options from real
 * availability"). Input is a conversation's already-resolved Step 3 vehicle and
 * Step 2 dates/location — never raw text — same convention as Steps 4-6.
 *
 * "AI can explain recommendations": ranking is a deterministic constraint ladder
 * (never an AI decision), and `reason` is deterministic, template-built text — the
 * same "AI may explain, must never decide" split Step 5's `reasonBuilder` already
 * established, not a live LLM call over untrusted output.
 *
 * "Never recommend unavailable inventory as available": a candidate is only ever
 * returned here once a live `AvailabilityProvider` check (the exact preview seam
 * Phase 6 built for this purpose) confirms `InventoryStatus.AVAILABLE` for the
 * requested dates at ranking time — a non-committal preview, not a hold. "Human
 * decision remains available": this engine never calls `ReservationLockService
 * .placeHold` for a candidate; a human/customer must still choose one and go
 * through Step 6's real hold flow to actually reserve it.
 */

export const AlternativeRecommendationStatus = {
  ALTERNATIVES_FOUND: 'ALTERNATIVES_FOUND',
  NO_ALTERNATIVES: 'NO_ALTERNATIVES',
} as const;

export const alternativeRecommendationStatusSchema = z.enum([
  AlternativeRecommendationStatus.ALTERNATIVES_FOUND,
  AlternativeRecommendationStatus.NO_ALTERNATIVES,
]);
export type AlternativeRecommendationStatusValue = z.infer<
  typeof alternativeRecommendationStatusSchema
>;

/**
 * Precondition failures thrown as `AppError` before any candidate is considered —
 * distinct from `AlternativeRecommendationStatus`, which describes a completed,
 * successful run that simply found zero (or more) qualifying candidates.
 */
export const AlternativesErrorCode = {
  VEHICLE_NOT_RESOLVED: 'VEHICLE_NOT_RESOLVED',
  DATES_NOT_RESOLVED: 'DATES_NOT_RESOLVED',
} as const;

export const alternativesErrorCodeSchema = z.enum([
  AlternativesErrorCode.VEHICLE_NOT_RESOLVED,
  AlternativesErrorCode.DATES_NOT_RESOLVED,
]);
export type AlternativesErrorCodeValue = z.infer<typeof alternativesErrorCodeSchema>;

/**
 * One ranked, confirmed-available candidate. `reason` names every ladder stage
 * that actually distinguished it (never a generic "good match"), and
 * `priceDifference`/`currency` are always relative to the requested vehicle's own
 * `pricingProfile` — the "price difference if authoritative" the spec asked for;
 * "authoritative" here means both vehicles quote the same currency (a real,
 * comparable figure) — a currency mismatch is a documented, honest `null`, never
 * a converted or guessed number (see rankingEngine.ts).
 */
export const alternativeCandidateSchema = z.object({
  vehicle: vehicleSchema,
  availabilitySource: z.string().min(1).max(100),
  availabilityCheckedAt: z.string().datetime(),
  priceDifference: z.number().nullable(),
  currency: z.string().length(3).nullable(),
  reason: z.string().min(1).max(500),
});
export type AlternativeCandidate = z.infer<typeof alternativeCandidateSchema>;

export const recommendAlternativesResultSchema = z.object({
  status: alternativeRecommendationStatusSchema,
  requestedVehicleId: z.string().uuid(),
  /** Top-ranked qualifying candidate, or null when `status` is `NO_ALTERNATIVES`. */
  primary: alternativeCandidateSchema.nullable(),
  /** Second-ranked qualifying candidate, or null when fewer than two qualify. */
  secondary: alternativeCandidateSchema.nullable(),
  /** Candidates evaluated before the availability/constraint filters — for audit/transparency, not a promise any of them qualified. */
  consideredCount: z.number().int().nonnegative(),
  modelMetadata: z.object({
    engine: z.string().min(1),
    version: z.string().min(1),
    deterministic: z.boolean(),
  }),
  checkedAt: z.string().datetime(),
});
export type RecommendAlternativesResult = z.infer<typeof recommendAlternativesResultSchema>;
