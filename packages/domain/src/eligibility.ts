import { z } from 'zod';
import { luxuryTierSchema } from './vehicle.js';

/**
 * Step 5 — Eligibility. MASTER-PLAN.md journey Step 5, `ELIGIBILITY_CHECK`
 * ("SYS" owner — deterministic domain logic, unlike Steps 1-4 which are
 * "AI proposes, deterministic domain logic verifies"). There is no AI
 * proposal stage here at all: an AI may later be used to *explain* a
 * decision in plain language to the customer, but this file and
 * `packages/ai/src/step5` are the entire, fully deterministic decision
 * surface — nothing here is an LLM output, and nothing downstream may
 * override what it decides.
 *
 * Customer age/nationality/license/passport data is new at this step —
 * Steps 1-4 never collect it — so it arrives as validated request-boundary
 * input (`eligibilityCustomerInputSchema`/`driverInputSchema`), not as
 * something re-read from a prior step's persisted result. Vehicle, dates and
 * location *are* read from what Steps 2-3 already resolved, the same
 * "never re-derive, read what was already verified" convention Step 4 uses.
 */

// ---------------------------------------------------------------------
// License
// ---------------------------------------------------------------------

/** MASTER-PLAN.md journey Step 5: "licence type (UAE / IDP)". */
export const LicenseType = {
  UAE: 'UAE',
  GCC: 'GCC',
  IDP: 'IDP',
  FOREIGN: 'FOREIGN',
} as const;

export const licenseTypeSchema = z.enum([
  LicenseType.UAE,
  LicenseType.GCC,
  LicenseType.IDP,
  LicenseType.FOREIGN,
]);
export type LicenseTypeValue = z.infer<typeof licenseTypeSchema>;

const iso2CountrySchema = z
  .string()
  .trim()
  .length(2, 'must be an ISO 3166-1 alpha-2 country code')
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 country code'));

const dateOfBirthSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'dateOfBirth must be YYYY-MM-DD')
  .refine(
    (value) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!match) return false;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      return (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day
      );
    },
    { message: 'dateOfBirth must be a real calendar date' },
  )
  .refine((value) => new Date(`${value}T00:00:00.000Z`).getTime() <= Date.now(), {
    message: 'dateOfBirth cannot be in the future',
  });

// ---------------------------------------------------------------------
// Request-boundary input — never trusted, Zod-validated before use.
// ---------------------------------------------------------------------

export const driverInputSchema = z.object({
  dateOfBirth: dateOfBirthSchema,
  nationality: iso2CountrySchema,
  licenseType: licenseTypeSchema,
  hasValidLicense: z.boolean(),
});
export type DriverInput = z.infer<typeof driverInputSchema>;

export const eligibilityCustomerInputSchema = driverInputSchema.extend({
  passportProvided: z.boolean(),
});
export type EligibilityCustomerInput = z.infer<typeof eligibilityCustomerInputSchema>;

// ---------------------------------------------------------------------
// Rule taxonomy
// ---------------------------------------------------------------------

export const EligibilityRuleCategory = {
  AGE: 'AGE',
  LICENSE: 'LICENSE',
  PASSPORT: 'PASSPORT',
  NATIONALITY: 'NATIONALITY',
  VEHICLE: 'VEHICLE',
  LOCATION: 'LOCATION',
  DRIVER_REQUIREMENT: 'DRIVER_REQUIREMENT',
} as const;

export const eligibilityRuleCategorySchema = z.enum([
  EligibilityRuleCategory.AGE,
  EligibilityRuleCategory.LICENSE,
  EligibilityRuleCategory.PASSPORT,
  EligibilityRuleCategory.NATIONALITY,
  EligibilityRuleCategory.VEHICLE,
  EligibilityRuleCategory.LOCATION,
  EligibilityRuleCategory.DRIVER_REQUIREMENT,
]);
export type EligibilityRuleCategoryValue = z.infer<typeof eligibilityRuleCategorySchema>;

/**
 * PASS/FAIL are a rule's own deterministic verdict. WAIVED means a rule
 * that would have FAILed was covered by a matching, auto-applicable
 * EligibilityException. REQUIRES_REVIEW means a rule that would have FAILed
 * has a matching exception, but the exception itself is high-risk and
 * cannot auto-apply — a human must confirm it (see EligibilityException).
 */
export const EligibilityRuleOutcome = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  WAIVED: 'WAIVED',
  REQUIRES_REVIEW: 'REQUIRES_REVIEW',
} as const;

export const eligibilityRuleOutcomeSchema = z.enum([
  EligibilityRuleOutcome.PASS,
  EligibilityRuleOutcome.FAIL,
  EligibilityRuleOutcome.WAIVED,
  EligibilityRuleOutcome.REQUIRES_REVIEW,
]);
export type EligibilityRuleOutcomeValue = z.infer<typeof eligibilityRuleOutcomeSchema>;

export const eligibilityRuleResultSchema = z.object({
  ruleId: z.string().min(1).max(100),
  category: eligibilityRuleCategorySchema,
  outcome: eligibilityRuleOutcomeSchema,
  message: z.string().min(1).max(300),
  waivedByExceptionId: z.string().uuid().optional(),
});
export type EligibilityRuleResult = z.infer<typeof eligibilityRuleResultSchema>;

// ---------------------------------------------------------------------
// Exceptions — tenant-configured, pre-approved carve-outs. Never an
// ad hoc, in-the-moment AI decision: an exception is data the engine
// looks up and applies deterministically, exactly like a policy rule.
// ---------------------------------------------------------------------

export const EligibilityExceptionType = {
  VIP: 'VIP',
  NATIONALITY_OVERRIDE: 'NATIONALITY_OVERRIDE',
  AGE_OVERRIDE: 'AGE_OVERRIDE',
  MANUAL_GRANT: 'MANUAL_GRANT',
} as const;

export const eligibilityExceptionTypeSchema = z.enum([
  EligibilityExceptionType.VIP,
  EligibilityExceptionType.NATIONALITY_OVERRIDE,
  EligibilityExceptionType.AGE_OVERRIDE,
  EligibilityExceptionType.MANUAL_GRANT,
]);
export type EligibilityExceptionTypeValue = z.infer<typeof eligibilityExceptionTypeSchema>;

/**
 * LOW: pre-vetted enough to auto-apply without a human in the loop (e.g. a
 * tenant-approved nationality carve-out). HIGH: the exception is recorded
 * and matched, but per "High-risk exceptions -> human", it never
 * auto-waives the rule — the decision becomes NEEDS_HUMAN_REVIEW instead.
 */
export const EligibilityRiskLevel = {
  LOW: 'LOW',
  HIGH: 'HIGH',
} as const;

export const eligibilityRiskLevelSchema = z.enum([
  EligibilityRiskLevel.LOW,
  EligibilityRiskLevel.HIGH,
]);
export type EligibilityRiskLevelValue = z.infer<typeof eligibilityRiskLevelSchema>;

export const eligibilityExceptionSchema = z.object({
  id: z.string().uuid(),
  type: eligibilityExceptionTypeSchema,
  /** Which customer this applies to (VIP/AGE_OVERRIDE/MANUAL_GRANT); null for a nationality-scoped exception. */
  scopeCustomerRef: z.string().min(1).max(200).nullable(),
  /** Which nationality this applies to (NATIONALITY_OVERRIDE); null for a customer-scoped exception. */
  scopeNationality: iso2CountrySchema.nullable(),
  waivedCategories: z.array(eligibilityRuleCategorySchema).min(1),
  riskLevel: eligibilityRiskLevelSchema,
  reason: z.string().min(1).max(500),
  active: z.boolean(),
  expiresAt: z.string().datetime().nullable(),
});
export type EligibilityException = z.infer<typeof eligibilityExceptionSchema>;

/**
 * What a caller supplies to create an exception (no `id`/`active` yet — the
 * repository assigns those). Validated before every write, the same
 * "never trust input" posture `eligibilityPolicyRulesSchema.parse` already
 * applies on the policy side — a malformed `waivedCategories`/
 * `scopeNationality` written without this check would otherwise only
 * surface later, as an uncaught `eligibilityExceptionSchema.parse` failure
 * on *every* read that happens to include the bad row.
 */
export const createEligibilityExceptionInputSchema = z.object({
  type: eligibilityExceptionTypeSchema,
  scopeCustomerRef: z.string().min(1).max(200).nullable(),
  scopeNationality: iso2CountrySchema.nullable(),
  waivedCategories: z.array(eligibilityRuleCategorySchema).min(1),
  riskLevel: eligibilityRiskLevelSchema,
  reason: z.string().min(1).max(500),
  expiresAt: z.date().nullable(),
});
export type CreateEligibilityExceptionInputValidated = z.infer<
  typeof createEligibilityExceptionInputSchema
>;

export const eligibilityExceptionAppliedSchema = z.object({
  exceptionId: z.string().uuid(),
  type: eligibilityExceptionTypeSchema,
  categoriesWaived: z.array(eligibilityRuleCategorySchema),
  riskLevel: eligibilityRiskLevelSchema,
  /** False when riskLevel is HIGH — matched but pending human confirmation, not yet in effect. */
  autoApplied: z.boolean(),
});
export type EligibilityExceptionApplied = z.infer<typeof eligibilityExceptionAppliedSchema>;

// ---------------------------------------------------------------------
// Policy — the configurable rule parameters. Rules themselves
// (packages/ai/src/step5) are fixed code; every tenant-specific number,
// list or threshold they read comes from here, so "configurable" never
// means "editable by an AI at decision time".
// ---------------------------------------------------------------------

export const vehicleTierRestrictionSchema = z.object({
  minAge: z.number().int().positive().max(120).optional(),
  blockedNationalities: z.array(iso2CountrySchema).optional(),
});
export type VehicleTierRestriction = z.infer<typeof vehicleTierRestrictionSchema>;

export const eligibilityPolicyRulesSchema = z.object({
  /** Global minimum age; a vehicle's luxury tier may require more (minAgeByLuxuryTier/vehicleRestrictions). */
  minAge: z.number().int().positive().max(120),
  minAgeByLuxuryTier: z.record(luxuryTierSchema, z.number().int().positive().max(120)).default({}),
  requiredLicenseTypes: z.array(licenseTypeSchema).min(1),
  passportRequired: z.boolean(),
  nationalityRules: z.object({
    blockedNationalities: z.array(iso2CountrySchema).default([]),
    /** Non-empty = allowlist mode: only these nationalities are eligible at all. */
    allowedNationalitiesOnly: z.array(iso2CountrySchema).default([]),
  }),
  /** Extra, tier-specific constraints layered on top of the base AGE/NATIONALITY rules. */
  vehicleRestrictions: z.record(luxuryTierSchema, vehicleTierRestrictionSchema).default({}),
  /** City names (matched against the resolved pickup/dropoff location's `city`, case-insensitive). */
  restrictedCities: z.array(z.string().trim().min(1).max(100)).default([]),
  driverRequirements: z.object({
    maxAdditionalDrivers: z.number().int().nonnegative().max(10),
    additionalDriverMinAge: z.number().int().positive().max(120),
    additionalDriversRequireValidLicense: z.boolean(),
  }),
});
export type EligibilityPolicyRules = z.infer<typeof eligibilityPolicyRulesSchema>;

export const eligibilityPolicySchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  version: z.number().int().positive(),
  active: z.boolean(),
  rules: eligibilityPolicyRulesSchema,
});
export type EligibilityPolicy = z.infer<typeof eligibilityPolicySchema>;

/** A structural inconsistency within a policy's own configured rules — see packages/ai/src/step5/policyValidator.ts. */
export const PolicyConflictCode = {
  NATIONALITY_IN_BOTH_LISTS: 'NATIONALITY_IN_BOTH_LISTS',
  TIER_MIN_AGE_BELOW_GLOBAL: 'TIER_MIN_AGE_BELOW_GLOBAL',
} as const;

export const policyConflictCodeSchema = z.enum([
  PolicyConflictCode.NATIONALITY_IN_BOTH_LISTS,
  PolicyConflictCode.TIER_MIN_AGE_BELOW_GLOBAL,
]);
export type PolicyConflictCodeValue = z.infer<typeof policyConflictCodeSchema>;

export const policyConflictSchema = z.object({
  code: policyConflictCodeSchema,
  message: z.string().min(1).max(300),
});
export type PolicyConflict = z.infer<typeof policyConflictSchema>;

// ---------------------------------------------------------------------
// Decision — the append-only, auditable output of one eligibility check.
// ---------------------------------------------------------------------

export const EligibilityDecisionStatus = {
  ELIGIBLE: 'ELIGIBLE',
  INELIGIBLE: 'INELIGIBLE',
  NEEDS_HUMAN_REVIEW: 'NEEDS_HUMAN_REVIEW',
} as const;

export const eligibilityDecisionStatusSchema = z.enum([
  EligibilityDecisionStatus.ELIGIBLE,
  EligibilityDecisionStatus.INELIGIBLE,
  EligibilityDecisionStatus.NEEDS_HUMAN_REVIEW,
]);
export type EligibilityDecisionStatusValue = z.infer<typeof eligibilityDecisionStatusSchema>;

export const eligibilityFlagsSchema = z.object({
  /** True when the tenant's own policy configuration was internally inconsistent (fails safe to NEEDS_HUMAN_REVIEW). */
  policyConflictDetected: z.boolean(),
});
export type EligibilityFlags = z.infer<typeof eligibilityFlagsSchema>;

export const eligibilityDecisionResultSchema = z.object({
  status: eligibilityDecisionStatusSchema,
  ruleResults: z.array(eligibilityRuleResultSchema),
  exceptionsApplied: z.array(eligibilityExceptionAppliedSchema),
  policyConflicts: z.array(policyConflictSchema),
  /** A single deterministic, human-readable summary — never AI-generated free text. */
  reason: z.string().min(1).max(500),
  policyId: z.string().uuid(),
  policyVersion: z.number().int().positive(),
  flags: eligibilityFlagsSchema,
  modelMetadata: z.object({
    engine: z.string().min(1),
    version: z.string().min(1),
    deterministic: z.boolean(),
  }),
});
export type EligibilityDecisionResult = z.infer<typeof eligibilityDecisionResultSchema>;
