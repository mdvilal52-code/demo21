import { z } from 'zod';
import { moneySchema } from './money.js';

/**
 * Step 8 — Quote (MASTER-PLAN.md journey Step 8, `QUOTE_ISSUED`, "SYS" owner:
 * "pricing engine: base rate, duration tiers, extras, deposit, VAT 5%; quote
 * expiry"). "AI must NEVER invent prices" — every amount in a `QuoteSnapshot`
 * is computed by `PricingCalculator` (packages/ai/src/step8, zero AI/LLM
 * calls, same "SYS owner" posture as Steps 5-6) from server-side
 * `PricingRules` plus the caller's *selections* (which extras, which
 * insurance tier) — never a client-supplied amount. `quoteSelectionsSchema`
 * below is the entire client-facing input surface for pricing, and it
 * contains no money field at all: that is the price-manipulation-prevention
 * boundary.
 */

export const InsuranceTier = {
  NONE: 'NONE',
  BASIC: 'BASIC',
  PREMIUM: 'PREMIUM',
} as const;

export const insuranceTierSchema = z.enum([
  InsuranceTier.NONE,
  InsuranceTier.BASIC,
  InsuranceTier.PREMIUM,
]);
export type InsuranceTierValue = z.infer<typeof insuranceTierSchema>;

/**
 * The customer's chosen options — identifiers and flags only, never an
 * amount. The server resolves every one of these against its own
 * `PricingRules`; an unknown `extraCode`/`discountCode` is rejected, never
 * silently priced at whatever the client implies.
 */
export const quoteSelectionsSchema = z
  .object({
    extraCodes: z.array(z.string().min(1).max(60)).max(20).default([]),
    insuranceTier: insuranceTierSchema.default(InsuranceTier.NONE),
    deliveryRequested: z.boolean().default(false),
    discountCode: z.string().min(1).max(60).nullable().default(null),
  })
  .strict();
export type QuoteSelections = z.infer<typeof quoteSelectionsSchema>;

export const QuoteLineItemCategory = {
  BASE_RENTAL: 'BASE_RENTAL',
  EXTRA: 'EXTRA',
  DELIVERY: 'DELIVERY',
  INSURANCE: 'INSURANCE',
} as const;

export const quoteLineItemCategorySchema = z.enum([
  QuoteLineItemCategory.BASE_RENTAL,
  QuoteLineItemCategory.EXTRA,
  QuoteLineItemCategory.DELIVERY,
  QuoteLineItemCategory.INSURANCE,
]);
export type QuoteLineItemCategoryValue = z.infer<typeof quoteLineItemCategorySchema>;

export const quoteLineItemSchema = z.object({
  category: quoteLineItemCategorySchema,
  code: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  quantity: z.number().int().positive(),
  unitAmount: moneySchema,
  /** Always `unitAmount * quantity`, precomputed and stored — never re-derived on read. */
  amount: moneySchema,
});
export type QuoteLineItem = z.infer<typeof quoteLineItemSchema>;

export const quoteTaxLineSchema = z.object({
  code: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  ratePercent: z.number().nonnegative(),
  amount: moneySchema,
});
export type QuoteTaxLine = z.infer<typeof quoteTaxLineSchema>;

export const quoteFeeLineSchema = z.object({
  code: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  amount: moneySchema,
});
export type QuoteFeeLine = z.infer<typeof quoteFeeLineSchema>;

/** `amount` is always a non-negative reduction — never a negative `Money`, subtracted explicitly during total calculation. */
export const quoteDiscountLineSchema = z.object({
  code: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  amount: moneySchema,
});
export type QuoteDiscountLine = z.infer<typeof quoteDiscountLineSchema>;

export const QuoteStatus = {
  ISSUED: 'ISSUED',
  PENDING_REVIEW: 'PENDING_REVIEW',
} as const;

export const quoteStatusSchema = z.enum([QuoteStatus.ISSUED, QuoteStatus.PENDING_REVIEW]);
export type QuoteStatusValue = z.infer<typeof quoteStatusSchema>;

/**
 * Precondition failures thrown as `AppError` before pricing runs, and
 * post-hoc validation failures `QuoteValidator` raises on read — distinct
 * from `QuoteStatus`, which describes a successfully issued quote.
 */
export const QuoteErrorCode = {
  VEHICLE_NOT_RESOLVED: 'VEHICLE_NOT_RESOLVED',
  DATES_NOT_RESOLVED: 'DATES_NOT_RESOLVED',
  /** Steps 2's dates were valid when resolved, but time has passed since — same staleness class Step 6 re-checks on every run. */
  PICKUP_DATE_NOW_IN_PAST: 'PICKUP_DATE_NOW_IN_PAST',
  RETURN_BEFORE_OR_EQUAL_PICKUP: 'RETURN_BEFORE_OR_EQUAL_PICKUP',
  UNKNOWN_EXTRA_CODE: 'UNKNOWN_EXTRA_CODE',
  UNKNOWN_DISCOUNT_CODE: 'UNKNOWN_DISCOUNT_CODE',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  QUOTE_TAMPERED: 'QUOTE_TAMPERED',
  QUOTE_NOT_FOUND: 'QUOTE_NOT_FOUND',
} as const;

export const quoteErrorCodeSchema = z.enum([
  QuoteErrorCode.VEHICLE_NOT_RESOLVED,
  QuoteErrorCode.DATES_NOT_RESOLVED,
  QuoteErrorCode.PICKUP_DATE_NOW_IN_PAST,
  QuoteErrorCode.RETURN_BEFORE_OR_EQUAL_PICKUP,
  QuoteErrorCode.UNKNOWN_EXTRA_CODE,
  QuoteErrorCode.UNKNOWN_DISCOUNT_CODE,
  QuoteErrorCode.CURRENCY_MISMATCH,
  QuoteErrorCode.QUOTE_EXPIRED,
  QuoteErrorCode.QUOTE_TAMPERED,
  QuoteErrorCode.QUOTE_NOT_FOUND,
]);
export type QuoteErrorCodeValue = z.infer<typeof quoteErrorCodeSchema>;

/**
 * Immutable once created — a "change" (different selections, or a re-quote
 * after the previous version expired) always produces a *new* row with the
 * same `quoteId` and `version + 1`, never an update to an existing one. Same
 * append-only-history convention as `VehicleDetermination`/`AvailabilityCheck`/
 * `AlternativeRecommendation`, specialized with a stable `quoteId` lineage
 * across versions.
 */
export const quoteSnapshotSchema = z.object({
  quoteId: z.string().uuid(),
  version: z.number().int().positive(),
  status: quoteStatusSchema,
  currency: z.string().length(3),
  lineItems: z.array(quoteLineItemSchema),
  taxes: z.array(quoteTaxLineSchema),
  fees: z.array(quoteFeeLineSchema),
  discounts: z.array(quoteDiscountLineSchema),
  deposit: moneySchema,
  /** Subtotal + taxes + fees - discounts. Excludes `deposit`, which is a refundable hold, not revenue — see PHASE-8.md §3. */
  total: moneySchema,
  validUntil: z.string().datetime(),
  /** Identifies which `PricingRules` version priced this quote — for audit, and so a re-quote after a rules change is visibly distinguishable. */
  pricingVersion: z.string().min(1),
  /** True when `PricingAnomalyDetector` flagged this quote for tier-3 (Manager) human review — see PHASE-8.md §3. */
  requiresHumanReview: z.boolean(),
  reviewReasons: z.array(z.string().min(1).max(300)),
  /** HMAC over this snapshot's own priced content — `QuoteValidator.verifyIntegrity` recomputes and compares it on every read; see quoteValidator.ts. */
  integrityHash: z.string().min(1),
  modelMetadata: z.object({
    engine: z.string().min(1),
    version: z.string().min(1),
    deterministic: z.boolean(),
  }),
  createdAt: z.string().datetime(),
});
export type QuoteSnapshot = z.infer<typeof quoteSnapshotSchema>;
