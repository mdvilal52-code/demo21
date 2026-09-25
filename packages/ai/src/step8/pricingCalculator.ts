import {
  AppError,
  InsuranceTier,
  Money,
  QuoteLineItemCategory,
  sumMoney,
  type QuoteLineItemCategoryValue,
  type QuoteSelections,
  type Vehicle,
} from '@ai-concierge/domain';
import type { PricingRules } from './pricingRules.js';

export interface ComputedLineItem {
  category: QuoteLineItemCategoryValue;
  code: string;
  description: string;
  quantity: number;
  unitAmount: Money;
  amount: Money;
}

export interface ComputedTaxLine {
  code: string;
  description: string;
  ratePercent: number;
  amount: Money;
}

export interface ComputedFeeLine {
  code: string;
  description: string;
  amount: Money;
}

export interface ComputedDiscountLine {
  code: string;
  description: string;
  amount: Money;
}

export interface PricingCalculationInput {
  vehicle: Vehicle;
  /** Whole rental days — Step 2's resolved pickup/return dates, already converted by the caller. */
  durationDays: number;
  selections: QuoteSelections;
  rules: PricingRules;
}

export interface PricingCalculationResult {
  currency: string;
  lineItems: ComputedLineItem[];
  taxes: ComputedTaxLine[];
  fees: ComputedFeeLine[];
  discounts: ComputedDiscountLine[];
  deposit: Money;
  /** Line items - discounts + fees + taxes. Excludes `deposit` (a refundable hold, not revenue). */
  total: Money;
}

/**
 * Step 8 — pure, deterministic pricing. "AI must NEVER invent prices": every
 * amount here comes from `PricingRules` (server-side config) or the
 * already-resolved `Vehicle` catalog row — never from `selections`, which
 * carries only identifiers/flags. A currency mismatch between the vehicle's
 * own `pricingProfile.currency` and `rules.currency` surfaces naturally as
 * soon as the two are combined (`Money.add`'s own guard), not via a separate
 * ad-hoc check — see the first `sumMoney`/`.add` call below.
 *
 * Order of operations (documented deliberately — the spec lists the
 * ingredients, not a pipeline order): line items (base rental + extras +
 * delivery + insurance) → discount (applied to the line-items subtotal only,
 * never to fees — an administrative fee isn't a promotional target) → fees →
 * VAT (on the discounted subtotal + fees, i.e. the taxable supply value) →
 * total. Taxing pre-discount amounts would overcharge VAT relative to what
 * is actually charged, so discount is applied before tax despite the spec's
 * literal word order listing "tax" before "discount" — see PHASE-8.md §3.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Billable rental days between Step 2's resolved pickup/return instants —
 * ceiling-based (any part of a day counts as a full day, standard car-rental
 * billing practice), minimum 1. A pure function of the two instants, so
 * "duration" itself never needs its own precondition check beyond what
 * `calculatePricing` already enforces on the result.
 */
export function computeRentalDurationDays(pickupAt: Date, returnAt: Date): number {
  return Math.max(1, Math.ceil((returnAt.getTime() - pickupAt.getTime()) / MS_PER_DAY));
}

export function calculatePricing(input: PricingCalculationInput): PricingCalculationResult {
  const { vehicle, durationDays, selections, rules } = input;

  if (!Number.isInteger(durationDays) || durationDays < 1) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Duration must be a positive whole number of days, got ${durationDays}`,
      { details: { code: 'INVALID_DURATION' } },
    );
  }

  const currency = rules.currency;
  const vehicleDailyRate = Money.fromMajorUnits(
    vehicle.pricingProfile.dailyRate,
    vehicle.pricingProfile.currency,
  );

  const lineItems: ComputedLineItem[] = [];

  const fullWeeks = Math.floor(durationDays / 7);
  const remainderDays = durationDays % 7;
  if (fullWeeks > 0 && vehicle.pricingProfile.weeklyRate !== undefined) {
    const weeklyRate = Money.fromMajorUnits(
      vehicle.pricingProfile.weeklyRate,
      vehicle.pricingProfile.currency,
    );
    lineItems.push({
      category: QuoteLineItemCategory.BASE_RENTAL,
      code: 'BASE_RENTAL_WEEKLY',
      description: `${vehicle.make} ${vehicle.model} — ${fullWeeks} week(s) at the weekly rate`,
      quantity: fullWeeks,
      unitAmount: weeklyRate,
      amount: weeklyRate.multiplyByInteger(fullWeeks),
    });
    if (remainderDays > 0) {
      lineItems.push({
        category: QuoteLineItemCategory.BASE_RENTAL,
        code: 'BASE_RENTAL_DAILY',
        description: `${vehicle.make} ${vehicle.model} — ${remainderDays} additional day(s) at the daily rate`,
        quantity: remainderDays,
        unitAmount: vehicleDailyRate,
        amount: vehicleDailyRate.multiplyByInteger(remainderDays),
      });
    }
  } else {
    lineItems.push({
      category: QuoteLineItemCategory.BASE_RENTAL,
      code: 'BASE_RENTAL_DAILY',
      description: `${vehicle.make} ${vehicle.model} — ${durationDays} day(s) at the daily rate`,
      quantity: durationDays,
      unitAmount: vehicleDailyRate,
      amount: vehicleDailyRate.multiplyByInteger(durationDays),
    });
  }

  for (const extraCode of selections.extraCodes) {
    const extra = rules.findExtra(extraCode);
    if (!extra) {
      throw new AppError('VALIDATION_FAILED', `Unknown extra code: ${extraCode}`, {
        details: { code: 'UNKNOWN_EXTRA_CODE', extraCode },
      });
    }
    lineItems.push({
      category: QuoteLineItemCategory.EXTRA,
      code: extra.code,
      description: extra.description,
      quantity: durationDays,
      unitAmount: extra.dailyRate,
      amount: extra.dailyRate.multiplyByInteger(durationDays),
    });
  }

  if (selections.deliveryRequested) {
    const deliveryFee = rules.deliveryFee();
    lineItems.push({
      category: QuoteLineItemCategory.DELIVERY,
      code: 'DELIVERY',
      description: 'Vehicle delivery to pickup location',
      quantity: 1,
      unitAmount: deliveryFee,
      amount: deliveryFee,
    });
  }

  if (selections.insuranceTier !== InsuranceTier.NONE) {
    const dailyInsurance = rules.insuranceDailyRate(selections.insuranceTier);
    lineItems.push({
      category: QuoteLineItemCategory.INSURANCE,
      code: `INSURANCE_${selections.insuranceTier}`,
      description: `${selections.insuranceTier} insurance coverage`,
      quantity: durationDays,
      unitAmount: dailyInsurance,
      amount: dailyInsurance.multiplyByInteger(durationDays),
    });
  }

  // First cross-currency operation — throws AppError CURRENCY_MISMATCH here
  // if the vehicle's own pricingProfile.currency disagrees with rules.currency.
  const lineItemsSubtotal = sumMoney(
    currency,
    lineItems.map((item) => item.amount),
  );

  const discounts: ComputedDiscountLine[] = [];
  if (selections.discountCode !== null) {
    const discount = rules.findDiscount(selections.discountCode);
    if (!discount) {
      throw new AppError('VALIDATION_FAILED', `Unknown discount code: ${selections.discountCode}`, {
        details: { code: 'UNKNOWN_DISCOUNT_CODE', discountCode: selections.discountCode },
      });
    }
    discounts.push({
      code: discount.code,
      description: discount.description,
      amount: lineItemsSubtotal.multiplyByRate(discount.percentOff, 100),
    });
  }
  const totalDiscount = sumMoney(
    currency,
    discounts.map((discount) => discount.amount),
  );
  const discountedSubtotal = lineItemsSubtotal.subtract(totalDiscount);

  const fees: ComputedFeeLine[] = [
    { code: 'SERVICE_FEE', description: 'Service fee', amount: rules.serviceFee() },
  ];
  const totalFees = sumMoney(
    currency,
    fees.map((fee) => fee.amount),
  );

  const taxableAmount = discountedSubtotal.add(totalFees);
  const vatAmount = taxableAmount.multiplyByRate(rules.vatRatePercent, 100);
  const taxes: ComputedTaxLine[] = [
    {
      code: 'VAT',
      description: `VAT ${rules.vatRatePercent}%`,
      ratePercent: rules.vatRatePercent,
      amount: vatAmount,
    },
  ];

  const total = discountedSubtotal.add(totalFees).add(vatAmount);

  const deposit =
    vehicle.pricingProfile.depositAmount !== undefined
      ? Money.fromMajorUnits(vehicle.pricingProfile.depositAmount, vehicle.pricingProfile.currency)
      : rules.defaultDepositAmount();

  return { currency, lineItems, taxes, fees, discounts, deposit, total };
}
