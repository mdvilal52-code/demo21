import { describe, expect, it } from 'vitest';
import { AppError } from '@ai-concierge/domain';
import { calculatePricing, computeRentalDurationDays } from './pricingCalculator.js';
import { PricingRules, type PricingRulesConfig } from './pricingRules.js';
import { Money } from '@ai-concierge/domain';
import { makeSelections, makeVehicle } from './test/fixtures.js';

const rules = new PricingRules();

describe('computeRentalDurationDays', () => {
  it('counts exactly 4 whole days ("4 days")', () => {
    const pickup = new Date('2026-10-15T10:00:00.000Z');
    const returnAt = new Date('2026-10-19T10:00:00.000Z');
    expect(computeRentalDurationDays(pickup, returnAt)).toBe(4);
  });

  it('rounds any partial day up to a full billable day', () => {
    const pickup = new Date('2026-10-15T10:00:00.000Z');
    const returnAt = new Date('2026-10-16T11:00:00.000Z'); // 25 hours
    expect(computeRentalDurationDays(pickup, returnAt)).toBe(2);
  });

  it('never returns less than 1 day', () => {
    const pickup = new Date('2026-10-15T10:00:00.000Z');
    const returnAt = new Date('2026-10-15T12:00:00.000Z'); // 2 hours
    expect(computeRentalDurationDays(pickup, returnAt)).toBe(1);
  });
});

describe('calculatePricing', () => {
  it('prices a plain 4-day rental with no extras ("4 days")', () => {
    const result = calculatePricing({
      vehicle: makeVehicle({ pricingProfile: { currency: 'AED', dailyRate: 3500 } }),
      durationDays: 4,
      selections: makeSelections(),
      rules,
    });

    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0]).toMatchObject({
      category: 'BASE_RENTAL',
      code: 'BASE_RENTAL_DAILY',
      quantity: 4,
    });
    expect(result.lineItems[0]!.amount.minorUnits).toBe(1_400_000);
    expect(result.deposit.minorUnits).toBe(200_000); // default deposit, vehicle has none set
    expect(result.total.minorUnits).toBe(1_475_250); // see PHASE-8.md §8 worked example
  });

  it('includes a service fee line ("fees")', () => {
    const result = calculatePricing({
      vehicle: makeVehicle(),
      durationDays: 1,
      selections: makeSelections(),
      rules,
    });
    expect(result.fees).toEqual([
      expect.objectContaining({
        code: 'SERVICE_FEE',
        amount: expect.objectContaining({ minorUnits: 5000 }),
      }),
    ]);
  });

  it('computes VAT at the configured rate on the discounted subtotal + fees ("tax")', () => {
    const result = calculatePricing({
      vehicle: makeVehicle({ pricingProfile: { currency: 'AED', dailyRate: 3500 } }),
      durationDays: 4,
      selections: makeSelections(),
      rules,
    });
    expect(result.taxes).toEqual([
      expect.objectContaining({
        code: 'VAT',
        ratePercent: 5,
        amount: expect.objectContaining({ minorUnits: 70_250 }),
      }),
    ]);
  });

  it('applies a percentage discount to the line-items subtotal, not to fees ("discount")', () => {
    const result = calculatePricing({
      vehicle: makeVehicle({ pricingProfile: { currency: 'AED', dailyRate: 3500 } }),
      durationDays: 4,
      selections: makeSelections({ discountCode: 'WELCOME10' }),
      rules,
    });
    expect(result.discounts).toEqual([
      expect.objectContaining({
        code: 'WELCOME10',
        amount: expect.objectContaining({ minorUnits: 140_000 }),
      }),
    ]);
    expect(result.total.minorUnits).toBe(1_328_250);
  });

  it('rounds VAT to the nearest fil, round-half-up, exactly once ("rounding")', () => {
    const result = calculatePricing({
      vehicle: makeVehicle({ pricingProfile: { currency: 'AED', dailyRate: 100.03 } }),
      durationDays: 1,
      selections: makeSelections(),
      rules,
    });
    expect(result.lineItems[0]!.amount.minorUnits).toBe(10_003);
    expect(result.taxes[0]!.amount.minorUnits).toBe(750); // 15003 * 5 / 100 = 750.15 -> 750
    expect(result.total.minorUnits).toBe(15_753);
  });

  it('never lets a discount larger than the subtotal produce a negative total ("zero/negative values")', () => {
    const generousRules = new PricingRules({
      ...defaultConfig(),
      discounts: [{ code: 'MEGA', description: 'Oversized test discount', percentOff: 150 }],
    });
    const result = calculatePricing({
      vehicle: makeVehicle({ pricingProfile: { currency: 'AED', dailyRate: 3500 } }),
      durationDays: 4,
      selections: makeSelections({ discountCode: 'MEGA' }),
      rules: generousRules,
    });
    expect(result.total.minorUnits).toBe(5_250); // subtotal clamped to 0 + fees 5000 + VAT on fees 250
    expect(result.total.minorUnits).toBeGreaterThanOrEqual(0);
  });

  it('rejects a zero or negative duration ("zero/negative values")', () => {
    expect(() =>
      calculatePricing({
        vehicle: makeVehicle(),
        durationDays: 0,
        selections: makeSelections(),
        rules,
      }),
    ).toThrow(AppError);
    expect(() =>
      calculatePricing({
        vehicle: makeVehicle(),
        durationDays: -1,
        selections: makeSelections(),
        rules,
      }),
    ).toThrow(AppError);
  });

  it('rejects a vehicle priced in a different currency than the pricing rules ("currency mismatch")', () => {
    const usdVehicle = makeVehicle({ pricingProfile: { currency: 'USD', dailyRate: 900 } });
    try {
      calculatePricing({
        vehicle: usdVehicle,
        durationDays: 3,
        selections: makeSelections(),
        rules,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).details?.code).toBe('CURRENCY_MISMATCH');
    }
  });

  it('rejects an unknown extra code', () => {
    expect(() =>
      calculatePricing({
        vehicle: makeVehicle(),
        durationDays: 2,
        selections: makeSelections({ extraCodes: ['NOT_A_REAL_EXTRA'] }),
        rules,
      }),
    ).toThrow(AppError);
  });

  it('rejects an unknown discount code', () => {
    expect(() =>
      calculatePricing({
        vehicle: makeVehicle(),
        durationDays: 2,
        selections: makeSelections({ discountCode: 'NOT_A_REAL_CODE' }),
        rules,
      }),
    ).toThrow(AppError);
  });

  it('prices extras, delivery, and insurance as separate line items', () => {
    const result = calculatePricing({
      vehicle: makeVehicle(),
      durationDays: 2,
      selections: makeSelections({
        extraCodes: ['GPS', 'CHILD_SEAT'],
        deliveryRequested: true,
        insuranceTier: 'PREMIUM',
      }),
      rules,
    });
    const codes = result.lineItems.map((item) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'BASE_RENTAL_DAILY',
        'GPS',
        'CHILD_SEAT',
        'DELIVERY',
        'INSURANCE_PREMIUM',
      ]),
    );
    expect(result.lineItems).toHaveLength(5);
  });

  it('applies the weekly rate for a full week and the daily rate for the remainder ("duration tiers")', () => {
    const result = calculatePricing({
      vehicle: makeVehicle({
        pricingProfile: { currency: 'AED', dailyRate: 3500, weeklyRate: 21_000 },
      }),
      durationDays: 8,
      selections: makeSelections(),
      rules,
    });
    expect(result.lineItems).toEqual([
      expect.objectContaining({
        code: 'BASE_RENTAL_WEEKLY',
        quantity: 1,
        amount: expect.objectContaining({ minorUnits: 2_100_000 }),
      }),
      expect.objectContaining({
        code: 'BASE_RENTAL_DAILY',
        quantity: 1,
        amount: expect.objectContaining({ minorUnits: 350_000 }),
      }),
    ]);
  });

  it("uses the vehicle's own deposit amount when set, instead of the default", () => {
    const result = calculatePricing({
      vehicle: makeVehicle({
        pricingProfile: { currency: 'AED', dailyRate: 3500, depositAmount: 10_000 },
      }),
      durationDays: 1,
      selections: makeSelections(),
      rules,
    });
    expect(result.deposit.minorUnits).toBe(1_000_000);
  });
});

function defaultConfig(): PricingRulesConfig {
  return {
    version: 'test',
    currency: 'AED',
    vatRatePercent: 5,
    serviceFee: Money.fromMajorUnits(50, 'AED'),
    deliveryFee: Money.fromMajorUnits(150, 'AED'),
    insuranceDailyRates: {
      NONE: Money.zero('AED'),
      BASIC: Money.fromMajorUnits(50, 'AED'),
      PREMIUM: Money.fromMajorUnits(120, 'AED'),
    },
    extras: [],
    discounts: [],
    defaultDepositAmount: Money.fromMajorUnits(2000, 'AED'),
    validityHours: 24,
    humanReviewDiscountPercentThreshold: 20,
  };
}
