import { z } from 'zod';

/**
 * Step 3 — Determine Vehicle. `Vehicle` is a fleet class/model catalog entry
 * (e.g. "Lamborghini Urus"), not an individual physical unit — matches
 * MASTER-PLAN.md's journey Step 3 "map preference to fleet class / model".
 * AI-side services *propose* which catalog entry the customer means;
 * `VehicleValidationService` (deterministic) is what actually decides
 * whether it's resolvable/bookable. This file is the contract between them
 * and the persistence/API layers, mirroring temporal.ts's structure.
 */

export const VehicleCategory = {
  SEDAN: 'SEDAN',
  SUV: 'SUV',
  COUPE: 'COUPE',
  CONVERTIBLE: 'CONVERTIBLE',
  SPORTS: 'SPORTS',
  VAN: 'VAN',
} as const;

export const vehicleCategorySchema = z.enum([
  VehicleCategory.SEDAN,
  VehicleCategory.SUV,
  VehicleCategory.COUPE,
  VehicleCategory.CONVERTIBLE,
  VehicleCategory.SPORTS,
  VehicleCategory.VAN,
]);
export type VehicleCategoryValue = z.infer<typeof vehicleCategorySchema>;

/** Ordered PREMIUM < LUXURY < ULTRA_LUXURY; every catalog entry is already a luxury rental. */
export const LuxuryTier = {
  PREMIUM: 'PREMIUM',
  LUXURY: 'LUXURY',
  ULTRA_LUXURY: 'ULTRA_LUXURY',
} as const;

export const luxuryTierSchema = z.enum([
  LuxuryTier.PREMIUM,
  LuxuryTier.LUXURY,
  LuxuryTier.ULTRA_LUXURY,
]);
export type LuxuryTierValue = z.infer<typeof luxuryTierSchema>;

export const Transmission = {
  AUTOMATIC: 'AUTOMATIC',
  MANUAL: 'MANUAL',
} as const;

export const transmissionSchema = z.enum([Transmission.AUTOMATIC, Transmission.MANUAL]);
export type TransmissionValue = z.infer<typeof transmissionSchema>;

/**
 * Coarse, catalog-level operating status — NOT a date-range booking
 * calendar. Real availability-by-date (holds, buffers) is journey Step 6
 * (`AVAILABILITY_CHECK`), a distinct later phase per PHASE-2.md §13; this is
 * just "is this fleet class currently offered at all right now".
 */
export const VehicleAvailabilityStatus = {
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  MAINTENANCE: 'MAINTENANCE',
} as const;

export const vehicleAvailabilityStatusSchema = z.enum([
  VehicleAvailabilityStatus.AVAILABLE,
  VehicleAvailabilityStatus.UNAVAILABLE,
  VehicleAvailabilityStatus.MAINTENANCE,
]);
export type VehicleAvailabilityStatusValue = z.infer<typeof vehicleAvailabilityStatusSchema>;

/**
 * A "budget hint" per MASTER-PLAN.md journey Step 3 — not the real pricing
 * engine (duration tiers, extras, VAT), which is Step 8 (`QUOTE_ISSUED`).
 */
export const pricingProfileSchema = z.object({
  currency: z.string().length(3), // ISO 4217, e.g. "AED"
  dailyRate: z.number().positive(),
  weeklyRate: z.number().positive().optional(),
  depositAmount: z.number().nonnegative().optional(),
});
export type PricingProfile = z.infer<typeof pricingProfileSchema>;

/** Public catalog shape — no tenantId/deletedAt leaked; those are internal DB concerns. */
export const vehicleSchema = z.object({
  id: z.string().uuid(),
  make: z.string().min(1).max(80),
  model: z.string().min(1).max(80),
  category: vehicleCategorySchema,
  luxuryTier: luxuryTierSchema,
  seats: z.number().int().positive().max(20),
  luggage: z.number().int().nonnegative().max(20),
  transmission: transmissionSchema,
  availabilityStatus: vehicleAvailabilityStatusSchema,
  pricingProfile: pricingProfileSchema,
  active: z.boolean(),
});
export type Vehicle = z.infer<typeof vehicleSchema>;

/** How VehicleIntentService arrived at a candidate — surfaced for transparency/audit. */
export const VehicleMatchType = {
  EXACT_MODEL: 'EXACT_MODEL',
  BRAND_ONLY: 'BRAND_ONLY',
  CATEGORY_ONLY: 'CATEGORY_ONLY',
  FUZZY_MATCH: 'FUZZY_MATCH',
  NONE: 'NONE',
} as const;

export const vehicleMatchTypeSchema = z.enum([
  VehicleMatchType.EXACT_MODEL,
  VehicleMatchType.BRAND_ONLY,
  VehicleMatchType.CATEGORY_ONLY,
  VehicleMatchType.FUZZY_MATCH,
  VehicleMatchType.NONE,
]);
export type VehicleMatchTypeValue = z.infer<typeof vehicleMatchTypeSchema>;

export const VehicleAmbiguityCode = {
  NO_VEHICLE_MENTIONED: 'NO_VEHICLE_MENTIONED',
  BRAND_ONLY_MULTIPLE_MATCHES: 'BRAND_ONLY_MULTIPLE_MATCHES',
  CATEGORY_ONLY_MULTIPLE_MATCHES: 'CATEGORY_ONLY_MULTIPLE_MATCHES',
  MULTIPLE_CANDIDATE_VEHICLES: 'MULTIPLE_CANDIDATE_VEHICLES',
} as const;

export const vehicleAmbiguityCodeSchema = z.enum([
  VehicleAmbiguityCode.NO_VEHICLE_MENTIONED,
  VehicleAmbiguityCode.BRAND_ONLY_MULTIPLE_MATCHES,
  VehicleAmbiguityCode.CATEGORY_ONLY_MULTIPLE_MATCHES,
  VehicleAmbiguityCode.MULTIPLE_CANDIDATE_VEHICLES,
]);
export type VehicleAmbiguityCodeValue = z.infer<typeof vehicleAmbiguityCodeSchema>;

export const vehicleAmbiguitySchema = z.object({
  field: z.literal('vehicle'),
  code: vehicleAmbiguityCodeSchema,
  message: z.string().min(1).max(300),
  raw: z.string().max(300).optional(),
});
export type VehicleAmbiguity = z.infer<typeof vehicleAmbiguitySchema>;

export const VehicleValidationErrorCode = {
  UNKNOWN_VEHICLE: 'UNKNOWN_VEHICLE',
  VEHICLE_INACTIVE: 'VEHICLE_INACTIVE',
  VEHICLE_UNAVAILABLE: 'VEHICLE_UNAVAILABLE',
} as const;

export const vehicleValidationErrorCodeSchema = z.enum([
  VehicleValidationErrorCode.UNKNOWN_VEHICLE,
  VehicleValidationErrorCode.VEHICLE_INACTIVE,
  VehicleValidationErrorCode.VEHICLE_UNAVAILABLE,
]);
export type VehicleValidationErrorCodeValue = z.infer<typeof vehicleValidationErrorCodeSchema>;

export const vehicleValidationErrorSchema = z.object({
  field: z.literal('vehicle'),
  code: vehicleValidationErrorCodeSchema,
  message: z.string().min(1).max(300),
  severity: z.enum(['ERROR', 'WARNING']),
});
export type VehicleValidationError = z.infer<typeof vehicleValidationErrorSchema>;

export const VehicleDeterminationStatus = {
  RESOLVED: 'RESOLVED',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
  UNSUPPORTED: 'UNSUPPORTED',
} as const;

export const vehicleDeterminationStatusSchema = z.enum([
  VehicleDeterminationStatus.RESOLVED,
  VehicleDeterminationStatus.NEEDS_CLARIFICATION,
  VehicleDeterminationStatus.UNSUPPORTED,
]);
export type VehicleDeterminationStatusValue = z.infer<typeof vehicleDeterminationStatusSchema>;

export const vehicleDeterminationFlagsSchema = z.object({
  promptInjectionDetected: z.boolean(),
});

export const vehicleDeterminationResultSchema = z.object({
  status: vehicleDeterminationStatusSchema,
  resolvedVehicle: vehicleSchema.nullable(),
  confidence: z.number().min(0).max(1),
  ambiguities: z.array(vehicleAmbiguitySchema),
  validationErrors: z.array(vehicleValidationErrorSchema),
  /** Real catalog entries offered when `resolvedVehicle` is null — never fabricated. */
  alternatives: z.array(vehicleSchema),
  flags: vehicleDeterminationFlagsSchema,
  modelMetadata: z.object({
    engine: z.string().min(1),
    version: z.string().min(1),
    deterministic: z.boolean(),
  }),
});
export type VehicleDeterminationResult = z.infer<typeof vehicleDeterminationResultSchema>;
