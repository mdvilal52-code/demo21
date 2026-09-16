import { z } from 'zod';

/**
 * Step 2 — Extract Dates & Location. AI-side services *propose* a result;
 * `TemporalValidationService` (deterministic) is what actually decides
 * whether it's usable. This file is the contract between them and the
 * persistence/API layers — every field here is something the deterministic
 * validator either confirmed or flagged, never a raw, unverified AI guess.
 */

export const LocationType = {
  AIRPORT: 'AIRPORT',
  HOTEL: 'HOTEL',
  LANDMARK: 'LANDMARK',
  ADDRESS: 'ADDRESS',
  CITY_AREA: 'CITY_AREA',
  UNKNOWN: 'UNKNOWN',
} as const;

export const locationTypeSchema = z.enum([
  LocationType.AIRPORT,
  LocationType.HOTEL,
  LocationType.LANDMARK,
  LocationType.ADDRESS,
  LocationType.CITY_AREA,
  LocationType.UNKNOWN,
]);
export type LocationTypeValue = z.infer<typeof locationTypeSchema>;

/** A location the extractor actually resolved against a known gazetteer/provider. */
export const normalizedLocationSchema = z.object({
  raw: z.string().min(1).max(200),
  normalized: z.string().min(1).max(200),
  city: z.string().min(1).max(100),
  country: z.string().length(2), // ISO 3166-1 alpha-2
  timezone: z.string().min(1).max(64), // IANA zone, e.g. "Asia/Dubai"
  locationType: locationTypeSchema,
});
export type NormalizedLocation = z.infer<typeof normalizedLocationSchema>;

export const AmbiguityCode = {
  AMBIGUOUS_NUMERIC_DATE: 'AMBIGUOUS_NUMERIC_DATE',
  VAGUE_RELATIVE_DATE: 'VAGUE_RELATIVE_DATE',
  BARE_WEEKDAY: 'BARE_WEEKDAY',
  UNRECOGNIZED_LOCATION_TEXT: 'UNRECOGNIZED_LOCATION_TEXT',
  MULTIPLE_CANDIDATE_LOCATIONS: 'MULTIPLE_CANDIDATE_LOCATIONS',
  MISSING_PICKUP_DATE: 'MISSING_PICKUP_DATE',
  MISSING_RETURN_DATE: 'MISSING_RETURN_DATE',
  MISSING_PICKUP_LOCATION: 'MISSING_PICKUP_LOCATION',
} as const;

export const ambiguityCodeSchema = z.enum([
  AmbiguityCode.AMBIGUOUS_NUMERIC_DATE,
  AmbiguityCode.VAGUE_RELATIVE_DATE,
  AmbiguityCode.BARE_WEEKDAY,
  AmbiguityCode.UNRECOGNIZED_LOCATION_TEXT,
  AmbiguityCode.MULTIPLE_CANDIDATE_LOCATIONS,
  AmbiguityCode.MISSING_PICKUP_DATE,
  AmbiguityCode.MISSING_RETURN_DATE,
  AmbiguityCode.MISSING_PICKUP_LOCATION,
]);
export type AmbiguityCodeValue = z.infer<typeof ambiguityCodeSchema>;

export const ambiguitySchema = z.object({
  field: z.enum(['pickupDate', 'returnDate', 'pickupLocation', 'dropoffLocation']),
  code: ambiguityCodeSchema,
  message: z.string().min(1).max(300),
  raw: z.string().max(300).optional(),
});
export type Ambiguity = z.infer<typeof ambiguitySchema>;

export const ValidationErrorCode = {
  IMPOSSIBLE_DATE: 'IMPOSSIBLE_DATE',
  PAST_DATE: 'PAST_DATE',
  RETURN_BEFORE_OR_EQUAL_PICKUP: 'RETURN_BEFORE_OR_EQUAL_PICKUP',
  TIMEZONE_MISMATCH: 'TIMEZONE_MISMATCH',
  UNSUPPORTED_LOCATION: 'UNSUPPORTED_LOCATION',
} as const;

export const validationErrorCodeSchema = z.enum([
  ValidationErrorCode.IMPOSSIBLE_DATE,
  ValidationErrorCode.PAST_DATE,
  ValidationErrorCode.RETURN_BEFORE_OR_EQUAL_PICKUP,
  ValidationErrorCode.TIMEZONE_MISMATCH,
  ValidationErrorCode.UNSUPPORTED_LOCATION,
]);
export type ValidationErrorCodeValue = z.infer<typeof validationErrorCodeSchema>;

export const validationErrorSchema = z.object({
  field: z.enum(['pickupDate', 'returnDate', 'pickupLocation', 'dropoffLocation', 'timezone']),
  code: validationErrorCodeSchema,
  message: z.string().min(1).max(300),
  severity: z.enum(['ERROR', 'WARNING']),
});
export type ValidationIssue = z.infer<typeof validationErrorSchema>;

export const dateLocationFlagsSchema = z.object({
  promptInjectionDetected: z.boolean(),
});

/** Default operating timezone while only Dubai/UAE is supported (see LocationExtractionService). */
export const DEFAULT_SERVICE_TIMEZONE = 'Asia/Dubai';

export const dateLocationExtractionResultSchema = z.object({
  pickupDate: z.string().datetime().nullable(),
  returnDate: z.string().datetime().nullable(),
  timezone: z.string().min(1).max(64).nullable(),
  pickupLocation: normalizedLocationSchema.nullable(),
  dropoffLocation: normalizedLocationSchema.nullable(),
  /** Mirrors pickupLocation's type (falling back to dropoffLocation's) for quick filtering. */
  locationType: locationTypeSchema.nullable(),
  confidence: z.number().min(0).max(1),
  ambiguities: z.array(ambiguitySchema),
  validationErrors: z.array(validationErrorSchema),
  flags: dateLocationFlagsSchema,
  modelMetadata: z.object({
    engine: z.string().min(1),
    version: z.string().min(1),
    deterministic: z.boolean(),
  }),
});
export type DateLocationExtractionResult = z.infer<typeof dateLocationExtractionResultSchema>;
