import { z } from 'zod';
import { AppError } from './errors.js';

/**
 * Step 8 — Quote/Pricing. Every financial amount in this codebase that
 * touches a quote total flows through this value object. "Decimal-safe,
 * never floating-point arithmetic for financial totals" means: amounts are
 * stored as an *integer* count of minor currency units (fils for AED — 100
 * fils = 1 AED, the same shape as cents), and every operation
 * (add/subtract/multiply/percentage) operates on that integer, never on a
 * JS float total. `Math.round` appears in exactly two controlled places —
 * `fromMajorUnits` (crossing the one unavoidable boundary: an existing
 * float-typed source like `Vehicle.pricingProfile.dailyRate`) and
 * `multiplyByRate` (a single, explicit round-half-up after an exact integer
 * multiply, the standard way money libraries implement percentages) — never
 * as a way to paper over compounding float error across a calculation
 * pipeline.
 */

export const moneySchema = z.object({
  // .nonnegative() so this Zod boundary — the re-parse every Quote row goes
  // through on every read (toDomainQuoteSnapshot) — independently enforces
  // the same invariant the Money class constructor already does, rather
  // than relying solely on the separate integrityHash check to catch a
  // negative amount written some other way (a migration, a manual fix, a
  // future admin tool).
  minorUnits: z.number().int().nonnegative(),
  currency: z.string().length(3), // ISO 4217, e.g. "AED"
});
export type MoneyJSON = z.infer<typeof moneySchema>;

function assertNonNegative(minorUnits: number, currency: string): void {
  if (minorUnits < 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Money amount cannot be negative: ${minorUnits} ${currency}`,
      { details: { code: 'NEGATIVE_MONEY_AMOUNT' } },
    );
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Currency mismatch: cannot combine ${a.currency} and ${b.currency}`,
      { details: { code: 'CURRENCY_MISMATCH', left: a.currency, right: b.currency } },
    );
  }
}

/**
 * An exact, non-negative amount of one currency, as an integer count of
 * minor units. Immutable — every operation returns a new `Money`.
 */
export class Money {
  private constructor(
    readonly minorUnits: number,
    readonly currency: string,
  ) {
    assertNonNegative(minorUnits, currency);
  }

  /** Direct integer constructor — the normal path once a value is already computed in minor units. */
  static fromMinorUnits(minorUnits: number, currency: string): Money {
    if (!Number.isInteger(minorUnits)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Money minor units must be an integer, got ${minorUnits}`,
        { details: { code: 'NON_INTEGER_MONEY_AMOUNT' } },
      );
    }
    return new Money(minorUnits, currency);
  }

  /**
   * The one controlled float boundary: converts an existing major-unit
   * float (e.g. `Vehicle.pricingProfile.dailyRate`, AED 3500) into an exact
   * integer minor-unit amount via a single `Math.round`, never carried
   * through subsequent arithmetic as a float.
   */
  static fromMajorUnits(amount: number, currency: string): Money {
    return new Money(Math.round(amount * 100), currency);
  }

  static zero(currency: string): Money {
    return new Money(0, currency);
  }

  add(other: Money): Money {
    assertSameCurrency(this, other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  /** Clamps at zero — a charge is never negative; see `PricingCalculator` for how a discount larger than its subtotal is handled. */
  subtract(other: Money): Money {
    assertSameCurrency(this, other);
    return new Money(Math.max(0, this.minorUnits - other.minorUnits), this.currency);
  }

  /** Exact integer multiply — for a whole-number factor (e.g. rental days), never a fractional one. */
  multiplyByInteger(factor: number): Money {
    if (!Number.isInteger(factor) || factor < 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Multiplier must be a non-negative integer, got ${factor}`,
        {
          details: { code: 'INVALID_MONEY_MULTIPLIER' },
        },
      );
    }
    return new Money(this.minorUnits * factor, this.currency);
  }

  /**
   * A percentage/rate as an exact integer fraction (e.g. 5% VAT =
   * `multiplyByRate(5, 100)`): the multiply by `numerator` is exact integer
   * arithmetic, and the single division by `denominator` is where
   * `Math.round` (round-half-up) is explicitly applied — the standard,
   * auditable way to compute a percentage of a minor-unit amount without
   * ever holding an intermediate float total.
   */
  multiplyByRate(numerator: number, denominator: number): Money {
    if (denominator <= 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Rate denominator must be positive, got ${denominator}`,
        {
          details: { code: 'INVALID_MONEY_RATE' },
        },
      );
    }
    return new Money(Math.round((this.minorUnits * numerator) / denominator), this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0;
  }

  lessThan(other: Money): boolean {
    assertSameCurrency(this, other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  /** The exact major-unit value as a string (e.g. "35.00") — for display only, never re-parsed back into arithmetic. */
  toMajorUnitsString(): string {
    const negative = this.minorUnits < 0 ? '-' : '';
    const abs = Math.abs(this.minorUnits);
    const whole = Math.floor(abs / 100);
    const fraction = String(abs % 100).padStart(2, '0');
    return `${negative}${whole}.${fraction}`;
  }

  toJSON(): MoneyJSON {
    return { minorUnits: this.minorUnits, currency: this.currency };
  }

  static fromJSON(value: MoneyJSON): Money {
    return Money.fromMinorUnits(value.minorUnits, value.currency);
  }
}

/** Sums a list of same-currency Money values; throws CURRENCY_MISMATCH on the first mismatch, same as `.add`. */
export function sumMoney(currency: string, values: Money[]): Money {
  return values.reduce((total, value) => total.add(value), Money.zero(currency));
}
