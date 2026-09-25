import { sumMoney } from '@ai-concierge/domain';
import type { PricingCalculationResult } from './pricingCalculator.js';
import type { PricingRules } from './pricingRules.js';

export interface AnomalyDetectionOptions {
  /**
   * Set only by a privileged, staff-only override path — no such path exists
   * yet in this codebase (no AuthN/AuthZ system; `PHASE-CONTRACTS.json` id-6
   * scope), so no live caller ever sets this true today. The check exists so
   * the seam is ready the moment that path is built, the same "built,
   * documented, not yet wired" posture Phase 6 used for `AvailabilityProvider`
   * before Phase 7 existed — see PHASE-8.md §9.
   */
  hasManualOverride?: boolean;
}

export interface AnomalyDetectionResult {
  requiresHumanReview: boolean;
  reviewReasons: string[];
}

/**
 * Step 8 — "Human review for: large discounts, custom deals, pricing
 * anomalies." Per `MASTER-PLAN.md`'s own escalation-tier table, "pricing
 * exceptions" are Tier 3 (Manager), not Tier 2 (Ops agent, which handles
 * documents/delivery/return/support) — see PHASE-8.md §1 for why this phase
 * follows that existing taxonomy. Purely a flag on the immutable
 * `QuoteSnapshot` (`requiresHumanReview`/`reviewReasons`); this phase does
 * not build a review queue/UI (that is `PHASE-CONTRACTS.json` id-7, Admin
 * Dashboard, still `PENDING`).
 *
 * The discount-percent check uses integer cross-multiplication
 * (`totalDiscount * 100 > threshold * subtotal`), never a float division, to
 * decide the boolean — the same decimal-safety standard as the pricing
 * calculation itself. A float division is used only to format the
 * human-readable message text, which is display output, not a financial
 * total.
 */
export function detectPricingAnomalies(
  result: PricingCalculationResult,
  rules: PricingRules,
  options: AnomalyDetectionOptions = {},
): AnomalyDetectionResult {
  const reasons: string[] = [];

  const lineItemsSubtotal = sumMoney(
    result.currency,
    result.lineItems.map((item) => item.amount),
  );
  const totalDiscount = sumMoney(
    result.currency,
    result.discounts.map((discount) => discount.amount),
  );

  if (!lineItemsSubtotal.isZero() && !totalDiscount.isZero()) {
    const exceedsThreshold =
      totalDiscount.minorUnits * 100 >
      rules.humanReviewDiscountPercentThreshold * lineItemsSubtotal.minorUnits;
    if (exceedsThreshold) {
      const discountPercent = (totalDiscount.minorUnits / lineItemsSubtotal.minorUnits) * 100;
      reasons.push(
        `Discount is ${discountPercent.toFixed(1)}% of the subtotal, above the ${rules.humanReviewDiscountPercentThreshold}% threshold`,
      );
    }
  }

  if (options.hasManualOverride) {
    reasons.push('Quote includes a custom/manual pricing override');
  }

  if (result.total.isZero()) {
    reasons.push('Computed total is zero');
  }

  return { requiresHumanReview: reasons.length > 0, reviewReasons: reasons };
}
