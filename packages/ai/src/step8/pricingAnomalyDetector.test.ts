import { describe, expect, it } from 'vitest';
import { Money } from '@ai-concierge/domain';
import { detectPricingAnomalies } from './pricingAnomalyDetector.js';
import { PricingRules } from './pricingRules.js';
import type { PricingCalculationResult } from './pricingCalculator.js';

const rules = new PricingRules(); // humanReviewDiscountPercentThreshold: 20

function makeResult(overrides: Partial<PricingCalculationResult> = {}): PricingCalculationResult {
  return {
    currency: 'AED',
    lineItems: [
      {
        category: 'BASE_RENTAL',
        code: 'BASE_RENTAL_DAILY',
        description: 'test',
        quantity: 4,
        unitAmount: Money.fromMajorUnits(3500, 'AED'),
        amount: Money.fromMinorUnits(1_400_000, 'AED'),
      },
    ],
    taxes: [],
    fees: [],
    discounts: [],
    deposit: Money.fromMajorUnits(2000, 'AED'),
    total: Money.fromMinorUnits(1_400_000, 'AED'),
    ...overrides,
  };
}

describe('detectPricingAnomalies', () => {
  it('does not flag a quote with no discount', () => {
    const result = detectPricingAnomalies(makeResult(), rules);
    expect(result.requiresHumanReview).toBe(false);
    expect(result.reviewReasons).toEqual([]);
  });

  it('does not flag a discount at or below the threshold ("large discounts" — negative case)', () => {
    const priced = makeResult({
      discounts: [
        { code: 'WELCOME10', description: 'Welcome', amount: Money.fromMinorUnits(140_000, 'AED') }, // 10%
      ],
    });
    expect(detectPricingAnomalies(priced, rules).requiresHumanReview).toBe(false);
  });

  it('flags a discount above the threshold ("large discounts")', () => {
    const priced = makeResult({
      discounts: [
        { code: 'MEGA', description: 'Big discount', amount: Money.fromMinorUnits(350_000, 'AED') }, // 25%
      ],
    });
    const result = detectPricingAnomalies(priced, rules);
    expect(result.requiresHumanReview).toBe(true);
    expect(result.reviewReasons[0]).toContain('25.0%');
  });

  it('flags exactly at the boundary as not requiring review, and one fil over as requiring it', () => {
    // subtotal 1,400,000; threshold 20% = 280,000 exactly.
    const atThreshold = makeResult({
      discounts: [{ code: 'X', description: 'x', amount: Money.fromMinorUnits(280_000, 'AED') }],
    });
    expect(detectPricingAnomalies(atThreshold, rules).requiresHumanReview).toBe(false);

    const overThreshold = makeResult({
      discounts: [{ code: 'X', description: 'x', amount: Money.fromMinorUnits(280_001, 'AED') }],
    });
    expect(detectPricingAnomalies(overThreshold, rules).requiresHumanReview).toBe(true);
  });

  it('flags a manual pricing override ("custom deals")', () => {
    const result = detectPricingAnomalies(makeResult(), rules, { hasManualOverride: true });
    expect(result.requiresHumanReview).toBe(true);
    expect(result.reviewReasons[0]).toContain('custom/manual pricing override');
  });

  it('flags a zero total ("pricing anomalies")', () => {
    const result = detectPricingAnomalies(makeResult({ total: Money.zero('AED') }), rules);
    expect(result.requiresHumanReview).toBe(true);
    expect(result.reviewReasons.some((reason) => reason.includes('zero'))).toBe(true);
  });

  it('collects every applicable reason, not just the first', () => {
    const priced = makeResult({
      discounts: [
        { code: 'MEGA', description: 'Big', amount: Money.fromMinorUnits(350_000, 'AED') },
      ],
      total: Money.zero('AED'),
    });
    const result = detectPricingAnomalies(priced, rules, { hasManualOverride: true });
    expect(result.reviewReasons).toHaveLength(3);
  });
});
