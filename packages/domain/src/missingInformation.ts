import { z } from 'zod';
import { tenantIdSchema } from './tenant.js';

/**
 * Step 4 — Ask Missing Information. Six candidate fields a booking-shaped
 * conversation may still need beyond what Steps 1-3 (intent, dates/location,
 * vehicle) already captured. AnswerExtractionService (AI proposes) reads the
 * customer's latest message; MissingFieldDetector + QuestionPolicy
 * (deterministic) decide what's genuinely missing and what to ask next.
 * ConversationState carries the running answer set across turns — the first
 * genuinely stateful, multi-turn step in the journey (Steps 1-3 each run
 * once per message; this one loops until complete, per MASTER-PLAN.md §4).
 */

export const MissingInfoFieldKey = {
  FLIGHT_NUMBER: 'FLIGHT_NUMBER',
  DROPOFF_ADDRESS: 'DROPOFF_ADDRESS',
  PICKUP_TIME: 'PICKUP_TIME',
  DRIVER_REQUIREMENT: 'DRIVER_REQUIREMENT',
  SPECIAL_REQUESTS: 'SPECIAL_REQUESTS',
  CONTACT_DETAILS: 'CONTACT_DETAILS',
} as const;

export const missingInfoFieldKeySchema = z.enum([
  MissingInfoFieldKey.FLIGHT_NUMBER,
  MissingInfoFieldKey.DROPOFF_ADDRESS,
  MissingInfoFieldKey.PICKUP_TIME,
  MissingInfoFieldKey.DRIVER_REQUIREMENT,
  MissingInfoFieldKey.SPECIAL_REQUESTS,
  MissingInfoFieldKey.CONTACT_DETAILS,
]);
export type MissingInfoFieldKeyValue = z.infer<typeof missingInfoFieldKeySchema>;

/** Every field this step can ever ask about. */
export const MISSING_INFO_FIELD_KEYS: readonly MissingInfoFieldKeyValue[] =
  Object.values(MissingInfoFieldKey);

/** The only field that never blocks completion — asked at most once, answer optional. */
export const OPTIONAL_MISSING_INFO_FIELDS: readonly MissingInfoFieldKeyValue[] = [
  MissingInfoFieldKey.SPECIAL_REQUESTS,
];

/**
 * Fields whose answer can't be pattern-matched and is instead "whatever the
 * customer replied." At most one of these is ever pending at a time (see
 * QuestionPolicy) so a free-text reply is never ambiguous about which one
 * it's answering.
 */
export const FREE_TEXT_MISSING_INFO_FIELDS: readonly MissingInfoFieldKeyValue[] = [
  MissingInfoFieldKey.DROPOFF_ADDRESS,
  MissingInfoFieldKey.SPECIAL_REQUESTS,
];

export const MissingInfoStatus = {
  AWAITING_CUSTOMER: 'AWAITING_CUSTOMER',
  COMPLETE: 'COMPLETE',
} as const;

export const missingInfoStatusSchema = z.enum([
  MissingInfoStatus.AWAITING_CUSTOMER,
  MissingInfoStatus.COMPLETE,
]);
export type MissingInfoStatusValue = z.infer<typeof missingInfoStatusSchema>;

/** Where a field's current value came from — never fabricated, always traceable. */
export const AnswerSource = {
  STEP1_INTENT: 'STEP1_INTENT',
  CUSTOMER_REPLY: 'CUSTOMER_REPLY',
} as const;

export const answerSourceSchema = z.enum([AnswerSource.STEP1_INTENT, AnswerSource.CUSTOMER_REPLY]);
export type AnswerSourceValue = z.infer<typeof answerSourceSchema>;

const flightNumberValueSchema = z.string().trim().min(2).max(10);
const addressValueSchema = z.string().trim().min(3).max(300);
/** Canonical 24h local clock time — normalized here, never stored as free text. */
const pickupTimeValueSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected 24h HH:MM');
const specialRequestsValueSchema = z.string().trim().min(1).max(500);
const contactDetailsValueSchema = z.string().trim().min(3).max(200);

/** Union of every possible field value shape — used by correction/contradiction records. */
export const missingInfoValueSchema = z.union([z.string(), z.boolean()]);
export type MissingInfoValue = z.infer<typeof missingInfoValueSchema>;

const answerBaseSchema = z.object({
  source: answerSourceSchema,
  answeredAt: z.string().datetime(),
  /** True once this value has replaced an earlier, different one for the same field. */
  corrected: z.boolean(),
});

/** Typed per-field answers — a booking string can never end up in a boolean field or vice versa. */
export const missingInfoAnswerSchema = z.discriminatedUnion('field', [
  answerBaseSchema.extend({
    field: z.literal(MissingInfoFieldKey.FLIGHT_NUMBER),
    value: flightNumberValueSchema,
  }),
  answerBaseSchema.extend({
    field: z.literal(MissingInfoFieldKey.DROPOFF_ADDRESS),
    value: addressValueSchema,
  }),
  answerBaseSchema.extend({
    field: z.literal(MissingInfoFieldKey.PICKUP_TIME),
    value: pickupTimeValueSchema,
  }),
  answerBaseSchema.extend({
    field: z.literal(MissingInfoFieldKey.DRIVER_REQUIREMENT),
    value: z.boolean(),
  }),
  answerBaseSchema.extend({
    field: z.literal(MissingInfoFieldKey.SPECIAL_REQUESTS),
    value: specialRequestsValueSchema,
  }),
  answerBaseSchema.extend({
    field: z.literal(MissingInfoFieldKey.CONTACT_DETAILS),
    value: contactDetailsValueSchema,
  }),
]);
export type MissingInfoAnswer = z.infer<typeof missingInfoAnswerSchema>;

export const pendingQuestionSchema = z.object({
  field: missingInfoFieldKeySchema,
  /** Stable template id (e.g. "ask.flightNumber.v1") — never the raw customer text. */
  questionId: z.string().min(1).max(100),
  text: z.string().min(1).max(500),
  language: z.string().min(2).max(10),
  required: z.boolean(),
  askedAt: z.string().datetime(),
});
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;

export const correctionRecordSchema = z.object({
  field: missingInfoFieldKeySchema,
  previousValue: missingInfoValueSchema,
  newValue: missingInfoValueSchema,
  detectedAt: z.string().datetime(),
});
export type CorrectionRecord = z.infer<typeof correctionRecordSchema>;

/** Two different values for the same field mentioned in the *same* message — never auto-resolved. */
export const contradictionRecordSchema = z.object({
  field: missingInfoFieldKeySchema,
  candidates: z.array(missingInfoValueSchema).min(2),
  message: z.string().min(1).max(300),
  detectedAt: z.string().datetime(),
});
export type ContradictionRecord = z.infer<typeof contradictionRecordSchema>;

export const missingInformationFlagsSchema = z.object({
  promptInjectionDetected: z.boolean(),
  piiDetected: z.boolean(),
});
export type MissingInformationFlags = z.infer<typeof missingInformationFlagsSchema>;

const modelMetadataSchema = z.object({
  engine: z.string().min(1),
  version: z.string().min(1),
  deterministic: z.boolean(),
});

export const missingInformationResultSchema = z.object({
  status: missingInfoStatusSchema,
  /** Required fields still missing — never includes an optional field. */
  missingFields: z.array(missingInfoFieldKeySchema),
  pendingQuestions: z.array(pendingQuestionSchema),
  /** Every field this step currently knows a value for — never a raw entity dump. */
  answers: z.array(missingInfoAnswerSchema),
  corrections: z.array(correctionRecordSchema),
  contradictions: z.array(contradictionRecordSchema),
  flags: missingInformationFlagsSchema,
  modelMetadata: modelMetadataSchema,
});
export type MissingInformationResult = z.infer<typeof missingInformationResultSchema>;

/** Abuse/runaway-loop cap — see MissingInformationEngine. */
export const MAX_MISSING_INFO_TURNS = 50;

/**
 * The persisted, mutable state for one conversation's Step 4 loop — unlike
 * IntentRecord/DateLocationExtraction/VehicleDetermination (one append-only
 * row per message), there is exactly one of these per conversation, updated
 * in place with optimistic version checks.
 */
export const conversationStateSchema = z.object({
  tenantId: tenantIdSchema,
  conversationId: z.string().uuid(),
  status: missingInfoStatusSchema,
  answers: z.array(missingInfoAnswerSchema),
  /** Every field key a question has ever been generated for — asked at most once each. */
  askedFieldKeys: z.array(missingInfoFieldKeySchema),
  pendingQuestions: z.array(pendingQuestionSchema),
  corrections: z.array(correctionRecordSchema),
  contradictions: z.array(contradictionRecordSchema),
  flags: missingInformationFlagsSchema,
  turnCount: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  /**
   * The message this state was last computed from — null before the first
   * turn. Lets the caller (missingInformationService) recognize a retried
   * request against an unchanged message and skip persisting a duplicate
   * turn/audit event, without needing a client-supplied idempotency key on
   * an endpoint that has no body to hash.
   */
  lastProcessedMessageId: z.string().uuid().nullable(),
});
export type ConversationStateData = z.infer<typeof conversationStateSchema>;
