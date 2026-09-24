import { Money, InsuranceTier, type InsuranceTierValue } from '@ai-concierge/domain';

/**
 * Step 8 — Quote/Pricing. The one place every rate, fee, and discount
 * definition lives. `QuoteSnapshot.pricingVersion` always equals
 * `PricingRules.version`, so a rate change is visible on every quote it
 * priced. Business config, not a `NOT_CONFIGURED`-style external
 * integration — no credentials involved, so there is nothing to report as
 * unavailable; a tenant-configurable, DB-backed version of this (the same
 * shape Step 5's `EligibilityPolicy` already uses) is a natural next step,
 * not built here (see PHASE-8.md §9).
 */

export interface ExtraDefinition {
  code: string;
  description: string;
  /** Charged once per rental day. */
  dailyRate: Money;
}

export interface DiscountDefinition {
  code: string;
  description: string;
  /** 0-100. Applied to the pre-tax, pre-fee subtotal. */
  percentOff: number;
}

export interface PricingRulesConfig {
  version: string;
  currency: string;
  vatRatePercent: number;
  serviceFee: Money;
  deliveryFee: Money;
  insuranceDailyRates: Record<InsuranceTierValue, Money>;
  extras: ExtraDefinition[];
  discounts: DiscountDefinition[];
  defaultDepositAmount: Money;
  validityHours: number;
  /** A computed discount above this percent-of-subtotal flags the quote for Tier-3 (Manager) human review — see PHASE-8.md §3. */
  humanReviewDiscountPercentThreshold: number;
}

export const DEFAULT_PRICING_RULES: PricingRulesConfig = {
  version: 'pricing-rules-v1',
  currency: 'AED',
  vatRatePercent: 5,
  serviceFee: Money.fromMajorUnits(50, 'AED'),
  deliveryFee: Money.fromMajorUnits(150, 'AED'),
  insuranceDailyRates: {
    [InsuranceTier.NONE]: Money.zero('AED'),
    [InsuranceTier.BASIC]: Money.fromMajorUnits(50, 'AED'),
    [InsuranceTier.PREMIUM]: Money.fromMajorUnits(120, 'AED'),
  },
  extras: [
    {
      code: 'CHILD_SEAT',
      description: 'Child safety seat',
      dailyRate: Money.fromMajorUnits(30, 'AED'),
    },
    { code: 'GPS', description: 'GPS navigation unit', dailyRate: Money.fromMajorUnits(20, 'AED') },
    {
      code: 'ADDITIONAL_DRIVER',
      description: 'Additional authorized driver',
      dailyRate: Money.fromMajorUnits(40, 'AED'),
    },
  ],
  discounts: [
    { code: 'WELCOME10', description: 'Welcome offer', percentOff: 10 },
    { code: 'LOYALTY15', description: 'Loyalty member offer', percentOff: 15 },
  ],
  defaultDepositAmount: Money.fromMajorUnits(2000, 'AED'),
  validityHours: 24,
  humanReviewDiscountPercentThreshold: 20,
};

export class PricingRules {
  constructor(private readonly config: PricingRulesConfig = DEFAULT_PRICING_RULES) {}

  get version(): string {
    return this.config.version;
  }

  get currency(): string {
    return this.config.currency;
  }

  get vatRatePercent(): number {
    return this.config.vatRatePercent;
  }

  get validityHours(): number {
    return this.config.validityHours;
  }

  get humanReviewDiscountPercentThreshold(): number {
    return this.config.humanReviewDiscountPercentThreshold;
  }

  serviceFee(): Money {
    return this.config.serviceFee;
  }

  deliveryFee(): Money {
    return this.config.deliveryFee;
  }

  insuranceDailyRate(tier: InsuranceTierValue): Money {
    return this.config.insuranceDailyRates[tier];
  }

  findExtra(code: string): ExtraDefinition | undefined {
    return this.config.extras.find((extra) => extra.code === code);
  }

  findDiscount(code: string): DiscountDefinition | undefined {
    return this.config.discounts.find((discount) => discount.code === code);
  }

  defaultDepositAmount(): Money {
    return this.config.defaultDepositAmount;
  }
}
