import { describe, expect, it } from 'vitest';
import { AppError } from './errors.js';
import { Money, moneySchema, sumMoney } from './money.js';

describe('moneySchema', () => {
  it('accepts a well-formed non-negative amount', () => {
    expect(moneySchema.safeParse({ minorUnits: 350_000, currency: 'AED' }).success).toBe(true);
    expect(moneySchema.safeParse({ minorUnits: 0, currency: 'AED' }).success).toBe(true);
  });

  it('rejects a negative amount at the schema boundary — not just at the Money class constructor', () => {
    // Proves the Zod re-validation every Quote row goes through on read
    // (toDomainQuoteSnapshot) independently catches this, not only the
    // separate integrityHash check.
    expect(moneySchema.safeParse({ minorUnits: -1, currency: 'AED' }).success).toBe(false);
  });
});

describe('Money', () => {
  describe('fromMajorUnits', () => {
    it('converts a major-unit amount to exact minor units', () => {
      expect(Money.fromMajorUnits(3500, 'AED').minorUnits).toBe(350_000);
    });

    it('rounds a fractional major-unit amount to the nearest minor unit', () => {
      expect(Money.fromMajorUnits(19.999, 'AED').minorUnits).toBe(2000);
      expect(Money.fromMajorUnits(19.994, 'AED').minorUnits).toBe(1999);
    });

    it('handles zero', () => {
      expect(Money.fromMajorUnits(0, 'AED').isZero()).toBe(true);
    });
  });

  describe('fromMinorUnits', () => {
    it('accepts an integer', () => {
      expect(Money.fromMinorUnits(150, 'AED').minorUnits).toBe(150);
    });

    it('rejects a non-integer amount', () => {
      expect(() => Money.fromMinorUnits(150.5, 'AED')).toThrow(AppError);
    });

    it('rejects a negative amount ("zero/negative values")', () => {
      expect(() => Money.fromMinorUnits(-1, 'AED')).toThrow(AppError);
      try {
        Money.fromMinorUnits(-1, 'AED');
        expect.unreachable();
      } catch (error) {
        expect((error as AppError).details?.code).toBe('NEGATIVE_MONEY_AMOUNT');
      }
    });
  });

  describe('add / subtract', () => {
    it('adds two same-currency amounts exactly', () => {
      const total = Money.fromMinorUnits(1000, 'AED').add(Money.fromMinorUnits(250, 'AED'));
      expect(total.minorUnits).toBe(1250);
    });

    it('subtracts exactly when the result is non-negative', () => {
      const remainder = Money.fromMinorUnits(1000, 'AED').subtract(
        Money.fromMinorUnits(400, 'AED'),
      );
      expect(remainder.minorUnits).toBe(600);
    });

    it('clamps subtraction at zero rather than going negative ("zero/negative values")', () => {
      const remainder = Money.fromMinorUnits(400, 'AED').subtract(
        Money.fromMinorUnits(1000, 'AED'),
      );
      expect(remainder.minorUnits).toBe(0);
    });

    it('rejects combining different currencies ("currency mismatch")', () => {
      const aed = Money.fromMinorUnits(1000, 'AED');
      const usd = Money.fromMinorUnits(1000, 'USD');
      expect(() => aed.add(usd)).toThrow(AppError);
      try {
        aed.subtract(usd);
        expect.unreachable();
      } catch (error) {
        expect((error as AppError).details?.code).toBe('CURRENCY_MISMATCH');
      }
    });
  });

  describe('multiplyByInteger', () => {
    it('multiplies exactly by a whole-number factor (e.g. rental days)', () => {
      const dailyRate = Money.fromMajorUnits(3500, 'AED');
      expect(dailyRate.multiplyByInteger(4).minorUnits).toBe(350_000 * 4);
    });

    it('rejects a fractional or negative multiplier', () => {
      const rate = Money.fromMajorUnits(100, 'AED');
      expect(() => rate.multiplyByInteger(1.5)).toThrow(AppError);
      expect(() => rate.multiplyByInteger(-1)).toThrow(AppError);
    });
  });

  describe('multiplyByRate ("tax", "rounding")', () => {
    it('computes an exact 5% VAT line with no float drift', () => {
      const subtotal = Money.fromMinorUnits(123_456, 'AED');
      const vat = subtotal.multiplyByRate(5, 100);
      expect(vat.minorUnits).toBe(Math.round((123_456 * 5) / 100));
      expect(vat.minorUnits).toBe(6173);
    });

    it('round-half-up is applied exactly once, deterministically, for a value that does not divide evenly', () => {
      const subtotal = Money.fromMinorUnits(101, 'AED'); // 101 * 5 / 100 = 5.05
      expect(subtotal.multiplyByRate(5, 100).minorUnits).toBe(5);
      const subtotal2 = Money.fromMinorUnits(111, 'AED'); // 111 * 5 / 100 = 5.55
      expect(subtotal2.multiplyByRate(5, 100).minorUnits).toBe(6);
    });

    it('rejects a non-positive denominator', () => {
      expect(() => Money.fromMinorUnits(100, 'AED').multiplyByRate(5, 0)).toThrow(AppError);
    });
  });

  describe('toMajorUnitsString', () => {
    it('formats with exactly two fraction digits', () => {
      expect(Money.fromMinorUnits(350_000, 'AED').toMajorUnitsString()).toBe('3500.00');
      expect(Money.fromMinorUnits(5, 'AED').toMajorUnitsString()).toBe('0.05');
      expect(Money.zero('AED').toMajorUnitsString()).toBe('0.00');
    });
  });

  describe('JSON round-trip', () => {
    it('serializes and deserializes without loss', () => {
      const original = Money.fromMajorUnits(1999.5, 'AED');
      const restored = Money.fromJSON(original.toJSON());
      expect(restored.equals(original)).toBe(true);
    });
  });

  describe('sumMoney', () => {
    it('sums a list of same-currency amounts', () => {
      const total = sumMoney('AED', [
        Money.fromMinorUnits(100, 'AED'),
        Money.fromMinorUnits(200, 'AED'),
        Money.fromMinorUnits(300, 'AED'),
      ]);
      expect(total.minorUnits).toBe(600);
    });

    it('returns zero for an empty list', () => {
      expect(sumMoney('AED', []).isZero()).toBe(true);
    });

    it('throws on the first currency mismatch it finds', () => {
      expect(() =>
        sumMoney('AED', [Money.fromMinorUnits(100, 'AED'), Money.fromMinorUnits(100, 'USD')]),
      ).toThrow(AppError);
    });
  });
});
