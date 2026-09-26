import { z } from 'zod';
import {
  eligibilityCustomerInputSchema,
  licenseTypeSchema,
  type EligibilityCustomerInput,
} from './eligibility.js';

/**
 * Step 5's customer/driver details as they are *collected over chat* — the
 * bridge between a conversation (where the customer gives them one message
 * at a time, in any order) and `eligibilityCustomerInputSchema` (which only
 * accepts a complete, validated record). Every field is nullable because a
 * customer rarely supplies all of them at once.
 *
 * These are the customer's own *claims*, not verified facts: MASTER-PLAN.md
 * Steps 9-10 (documents requested / verified) are what later confirm them
 * against a passport and licence scan. Eligibility decided on claimed data
 * is therefore only ever a pre-qualification, and the customer-facing
 * wording says so (see `journeyReplyService.ts`).
 */
export const EligibilityIntakeField = {
  DATE_OF_BIRTH: 'DATE_OF_BIRTH',
  NATIONALITY: 'NATIONALITY',
  LICENSE_TYPE: 'LICENSE_TYPE',
  LICENSE_VALID: 'LICENSE_VALID',
  PASSPORT: 'PASSPORT',
} as const;

export const eligibilityIntakeFieldSchema = z.enum([
  EligibilityIntakeField.DATE_OF_BIRTH,
  EligibilityIntakeField.NATIONALITY,
  EligibilityIntakeField.LICENSE_TYPE,
  EligibilityIntakeField.LICENSE_VALID,
  EligibilityIntakeField.PASSPORT,
]);
export type EligibilityIntakeFieldValue = z.infer<typeof eligibilityIntakeFieldSchema>;

export const eligibilityIntakeSchema = z.object({
  dateOfBirth: z.string().nullable(),
  nationality: z.string().nullable(),
  licenseType: licenseTypeSchema.nullable(),
  hasValidLicense: z.boolean().nullable(),
  passportProvided: z.boolean().nullable(),
});
export type EligibilityIntake = z.infer<typeof eligibilityIntakeSchema>;

export function createEmptyEligibilityIntake(): EligibilityIntake {
  return {
    dateOfBirth: null,
    nationality: null,
    licenseType: null,
    hasValidLicense: null,
    passportProvided: null,
  };
}

/**
 * Which fields are still needed before Step 5 can run. A field that is
 * present but fails Step 5's own validation (e.g. an impossible date) still
 * counts as missing — `toEligibilityCustomerInput` is the single source of
 * truth for "complete", so this list can never disagree with it.
 */
export function findMissingEligibilityFields(
  intake: EligibilityIntake,
): EligibilityIntakeFieldValue[] {
  const missing: EligibilityIntakeFieldValue[] = [];
  const dateOfBirth = eligibilityCustomerInputSchema.shape.dateOfBirth.safeParse(
    intake.dateOfBirth,
  );
  if (intake.dateOfBirth === null || !dateOfBirth.success) {
    missing.push(EligibilityIntakeField.DATE_OF_BIRTH);
  }
  const nationality = eligibilityCustomerInputSchema.shape.nationality.safeParse(
    intake.nationality,
  );
  if (intake.nationality === null || !nationality.success) {
    missing.push(EligibilityIntakeField.NATIONALITY);
  }
  if (intake.licenseType === null) missing.push(EligibilityIntakeField.LICENSE_TYPE);
  if (intake.hasValidLicense === null) missing.push(EligibilityIntakeField.LICENSE_VALID);
  if (intake.passportProvided === null) missing.push(EligibilityIntakeField.PASSPORT);
  return missing;
}

/** `null` until every field is present and valid; otherwise the exact body Step 5 accepts. */
export function toEligibilityCustomerInput(
  intake: EligibilityIntake,
): EligibilityCustomerInput | null {
  const parsed = eligibilityCustomerInputSchema.safeParse(intake);
  return parsed.success ? parsed.data : null;
}

/**
 * Shape a model's extraction response must satisfy before any of it is even
 * considered (see `extractIntakeWithAI` in @ai-concierge/ai). Lives here, next
 * to the intake it produces, so the AI package never needs its own schema
 * dependency — and every value is still re-validated individually afterwards.
 */
export const aiIntakeExtractionSchema = z.object({
  dateOfBirth: z.string().nullable().optional(),
  nationalityIso2: z.string().nullable().optional(),
  licenseType: z.string().nullable().optional(),
  hasValidLicense: z.boolean().nullable().optional(),
  passportProvided: z.boolean().nullable().optional(),
  evidence: z
    .object({
      dateOfBirth: z.string().nullable().optional(),
      nationality: z.string().nullable().optional(),
      licenseType: z.string().nullable().optional(),
      hasValidLicense: z.string().nullable().optional(),
      passportProvided: z.string().nullable().optional(),
    })
    .partial()
    .optional(),
});
export type AiIntakeExtraction = z.infer<typeof aiIntakeExtractionSchema>;
