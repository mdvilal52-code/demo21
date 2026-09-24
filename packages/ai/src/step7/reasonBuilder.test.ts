import { describe, expect, it } from 'vitest';
import { buildAlternativeReason } from './reasonBuilder.js';
import { rankAlternatives } from './rankingEngine.js';
import { makeVehicle } from './test/fixtures.js';

const CHECKED_AT = new Date('2026-10-01T00:00:00.000Z');

describe('buildAlternativeReason', () => {
  it('names the category, tier, price and brand findings for a close match', () => {
    const requested = makeVehicle({
      id: 'req-1',
      make: 'Lamborghini',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 1000 },
    });
    const candidateVehicle = makeVehicle({
      id: 'c1',
      make: 'Lamborghini',
      model: 'Urus S',
      category: 'SUV',
      luxuryTier: 'LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 1100 },
    });
    const { qualifying } = rankAlternatives(requested, [
      {
        vehicle: candidateVehicle,
        outcome: { status: 'AVAILABLE', source: 'database-fleet', reason: null, retryable: false },
        checkedAt: CHECKED_AT,
      },
    ]);

    const reason = buildAlternativeReason(requested, qualifying[0]!);

    expect(reason).toContain('Urus S');
    expect(reason).toContain('same category');
    expect(reason).toContain('same luxury tier');
    expect(reason).toContain('AED 100/day more than requested');
    expect(reason).toContain('same make');
  });

  it('reports a price conflict honestly instead of fabricating a figure', () => {
    const requested = makeVehicle({
      id: 'req-1',
      category: 'SUV',
      pricingProfile: { currency: 'AED', dailyRate: 1000 },
    });
    const candidateVehicle = makeVehicle({
      id: 'c1',
      category: 'SUV',
      pricingProfile: { currency: 'USD', dailyRate: 300 },
    });
    const { qualifying } = rankAlternatives(requested, [
      {
        vehicle: candidateVehicle,
        outcome: { status: 'AVAILABLE', source: 'database-fleet', reason: null, retryable: false },
        checkedAt: CHECKED_AT,
      },
    ]);

    const reason = buildAlternativeReason(requested, qualifying[0]!);

    expect(reason).toContain('not directly comparable');
    expect(reason).not.toMatch(/AED|USD \d/);
  });

  it('never mentions a same-make finding for a different brand', () => {
    const requested = makeVehicle({
      id: 'req-1',
      make: 'Lamborghini',
      category: 'SUV',
      pricingProfile: { currency: 'AED', dailyRate: 1000 },
    });
    const candidateVehicle = makeVehicle({
      id: 'c1',
      make: 'Bentley',
      category: 'SUV',
      pricingProfile: { currency: 'AED', dailyRate: 1000 },
    });
    const { qualifying } = rankAlternatives(requested, [
      {
        vehicle: candidateVehicle,
        outcome: { status: 'AVAILABLE', source: 'database-fleet', reason: null, retryable: false },
        checkedAt: CHECKED_AT,
      },
    ]);

    const reason = buildAlternativeReason(requested, qualifying[0]!);

    expect(reason).not.toContain('same make');
  });
});
