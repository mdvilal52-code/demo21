import { describe, expect, it } from 'vitest';
import type { AvailabilityCheckOutcome } from '../step6/availabilityProvider.js';
import { rankAlternatives } from './rankingEngine.js';
import type { EvaluatedCandidate } from './types.js';
import { makeVehicle } from './test/fixtures.js';

const CHECKED_AT = new Date('2026-10-01T00:00:00.000Z');

function available(overrides: Partial<AvailabilityCheckOutcome> = {}): AvailabilityCheckOutcome {
  return {
    status: 'AVAILABLE',
    source: 'database-fleet',
    reason: null,
    retryable: false,
    ...overrides,
  };
}

function candidate(
  vehicleOverrides: Partial<Parameters<typeof makeVehicle>[0]> = {},
  outcome: AvailabilityCheckOutcome = available(),
): EvaluatedCandidate {
  return { vehicle: makeVehicle(vehicleOverrides), outcome, checkedAt: CHECKED_AT };
}

describe('rankAlternatives', () => {
  it('returns no qualifying candidates when none were evaluated ("no alternative")', () => {
    const requested = makeVehicle({ id: 'req-1' });
    const result = rankAlternatives(requested, []);
    expect(result.qualifying).toEqual([]);
    expect(result.consideredCount).toBe(0);
  });

  it('returns exactly one qualifying candidate ("one alternative")', () => {
    const requested = makeVehicle({ id: 'req-1' });
    const only = candidate({ id: 'c1', model: 'Cullinan' });
    const result = rankAlternatives(requested, [only]);
    expect(result.qualifying).toHaveLength(1);
    expect(result.qualifying[0]!.vehicle.id).toBe('c1');
    expect(result.consideredCount).toBe(1);
  });

  it('ranks many qualifying candidates and keeps every one of them ("many alternatives")', () => {
    const requested = makeVehicle({ id: 'req-1', category: 'SUV' });
    const evaluated = [
      candidate({ id: 'c1', category: 'SEDAN' }),
      candidate({ id: 'c2', category: 'SUV' }),
      candidate({ id: 'c3', category: 'COUPE' }),
    ];
    const result = rankAlternatives(requested, evaluated);
    expect(result.consideredCount).toBe(3);
    expect(result.qualifying).toHaveLength(3);
  });

  it('never recommends a candidate the live availability check did not confirm AVAILABLE', () => {
    const requested = makeVehicle({ id: 'req-1' });
    const evaluated = [
      candidate({ id: 'held' }, available({ status: 'UNAVAILABLE', reason: 'No units available' })),
      candidate({ id: 'maint' }, available({ status: 'MAINTENANCE', reason: 'Under maintenance' })),
      candidate(
        { id: 'unknown' },
        available({ status: 'UNKNOWN', reason: 'timeout', retryable: true }),
      ),
      candidate({ id: 'ok' }),
    ];
    const result = rankAlternatives(requested, evaluated);
    expect(result.consideredCount).toBe(4);
    expect(result.qualifying).toHaveLength(1);
    expect(result.qualifying[0]!.vehicle.id).toBe('ok');
  });

  it('filters out a candidate that cannot seat/carry what the requested vehicle could (customer constraints)', () => {
    const requested = makeVehicle({ id: 'req-1', seats: 5, luggage: 3 });
    const evaluated = [
      candidate({ id: 'too-small', seats: 2, luggage: 1 }),
      candidate({ id: 'big-enough', seats: 5, luggage: 3 }),
      candidate({ id: 'roomier', seats: 7, luggage: 5 }),
    ];
    const result = rankAlternatives(requested, evaluated);
    const ids = result.qualifying.map((c) => c.vehicle.id);
    expect(ids).toEqual(['big-enough', 'roomier']);
  });

  it('ranks a same-category candidate above an equally-priced different-category one', () => {
    const requested = makeVehicle({ id: 'req-1', category: 'SUV' });
    const sameCategory = candidate({
      id: 'same-cat',
      category: 'SUV',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
    const otherCategory = candidate({
      id: 'other-cat',
      category: 'SEDAN',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
    const result = rankAlternatives(requested, [otherCategory, sameCategory]);
    expect(result.qualifying.map((c) => c.vehicle.id)).toEqual(['same-cat', 'other-cat']);
    expect(result.qualifying[0]!.ranking.sameCategory).toBe(true);
  });

  it('breaks a category tie by luxury tier distance', () => {
    const requested = makeVehicle({ id: 'req-1', category: 'SUV', luxuryTier: 'LUXURY' });
    const sameTier = candidate({ id: 'same-tier', category: 'SUV', luxuryTier: 'LUXURY' });
    const farTier = candidate({ id: 'far-tier', category: 'SUV', luxuryTier: 'ULTRA_LUXURY' });
    const result = rankAlternatives(requested, [farTier, sameTier]);
    expect(result.qualifying.map((c) => c.vehicle.id)).toEqual(['same-tier', 'far-tier']);
  });

  it('does not exhibit an upsell bias: the closer price wins regardless of direction ("biased recommendation test")', () => {
    // Requested rate 1000. Cheaper candidate is 100 away; pricier candidate is
    // 300 away. If the engine had a hidden preference for the more expensive
    // option, "pricier" would win despite being the worse match.
    const requested = makeVehicle({
      id: 'req-1',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 1000 },
    });
    const cheaperCloser = candidate({
      id: 'cheaper',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 900 },
    });
    const pricierFarther = candidate({
      id: 'pricier',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 1300 },
    });
    const result = rankAlternatives(requested, [pricierFarther, cheaperCloser]);
    expect(result.qualifying.map((c) => c.vehicle.id)).toEqual(['cheaper', 'pricier']);
    expect(result.qualifying[0]!.ranking.priceDifference).toBe(-100);
  });

  it('treats equidistant cheaper/pricier candidates as a true tie on the price stage (no revenue-direction preference)', () => {
    const requested = makeVehicle({
      id: 'req-1',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 1000 },
    });
    const cheaper = candidate({
      id: 'zzz-cheaper',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 900 },
    });
    const pricier = candidate({
      id: 'aaa-pricier',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 1100 },
    });
    const result = rankAlternatives(requested, [cheaper, pricier]);
    // Neither systematically wins on price (both |diff| = 100); the id
    // tiebreak decides, not price direction — proven by picking ids where
    // the "pricier" one would win the tiebreak if it were run first.
    expect(result.qualifying.map((c) => c.vehicle.id)).toEqual(['aaa-pricier', 'zzz-cheaper']);
  });

  it('honestly reports no price comparison for a different-currency candidate ("price conflict") without excluding it', () => {
    const requested = makeVehicle({
      id: 'req-1',
      category: 'SUV',
      pricingProfile: { currency: 'AED', dailyRate: 1000 },
    });
    const differentCurrency = candidate({
      id: 'usd-car',
      category: 'SUV',
      pricingProfile: { currency: 'USD', dailyRate: 300 },
    });
    const result = rankAlternatives(requested, [differentCurrency]);
    expect(result.qualifying).toHaveLength(1);
    expect(result.qualifying[0]!.ranking.priceDifference).toBeNull();
    expect(result.qualifying[0]!.ranking.currency).toBeNull();
  });

  it('ranks a different-currency candidate after every candidate with a real price comparison', () => {
    const requested = makeVehicle({
      id: 'req-1',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 1000 },
    });
    const noPriceSignal = candidate({
      id: 'usd-car',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'USD', dailyRate: 300 },
    });
    const farButComparable = candidate({
      id: 'far-aed',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 5000 },
    });
    const result = rankAlternatives(requested, [noPriceSignal, farButComparable]);
    expect(result.qualifying.map((c) => c.vehicle.id)).toEqual(['far-aed', 'usd-car']);
  });

  it('prefers the same make as the requested vehicle as the final ranked stage ("preference")', () => {
    const requested = makeVehicle({
      id: 'req-1',
      make: 'Lamborghini',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 1000 },
    });
    const sameBrand = candidate({
      id: 'same-brand',
      make: 'Lamborghini',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 1000 },
    });
    const otherBrand = candidate({
      id: 'other-brand',
      make: 'Bentley',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 1000 },
    });
    const result = rankAlternatives(requested, [otherBrand, sameBrand]);
    expect(result.qualifying.map((c) => c.vehicle.id)).toEqual(['same-brand', 'other-brand']);
  });

  it('is a pure function: the same inputs always produce the same order', () => {
    const requested = makeVehicle({ id: 'req-1' });
    const evaluated = [candidate({ id: 'a' }), candidate({ id: 'b' }), candidate({ id: 'c' })];
    const first = rankAlternatives(requested, evaluated).qualifying.map((c) => c.vehicle.id);
    const second = rankAlternatives(requested, evaluated).qualifying.map((c) => c.vehicle.id);
    expect(first).toEqual(second);
  });
});
