import { describe, expect, it } from 'vitest';
import { AppError } from '@ai-concierge/domain';
import type { QuoteSnapshot } from '@ai-concierge/domain';
import {
  isQuoteExpired,
  QuoteValidator,
  signQuoteSnapshot,
  verifyQuoteIntegrity,
} from './quoteValidator.js';

const SECRET = 'a-very-long-test-secret-value-1234567890';
const NOW = new Date('2026-10-01T00:00:00.000Z');

function makeSnapshot(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  const base = {
    quoteId: '11111111-1111-1111-1111-111111111111',
    version: 1,
    status: 'ISSUED' as const,
    currency: 'AED',
    lineItems: [
      {
        category: 'BASE_RENTAL' as const,
        code: 'BASE_RENTAL_DAILY',
        description: 'Urus — 4 day(s)',
        quantity: 4,
        unitAmount: { minorUnits: 350_000, currency: 'AED' },
        amount: { minorUnits: 1_400_000, currency: 'AED' },
      },
    ],
    taxes: [
      {
        code: 'VAT',
        description: 'VAT 5%',
        ratePercent: 5,
        amount: { minorUnits: 70_250, currency: 'AED' },
      },
    ],
    fees: [
      {
        code: 'SERVICE_FEE',
        description: 'Service fee',
        amount: { minorUnits: 5000, currency: 'AED' },
      },
    ],
    discounts: [],
    deposit: { minorUnits: 200_000, currency: 'AED' },
    total: { minorUnits: 1_475_250, currency: 'AED' },
    validUntil: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    pricingVersion: 'pricing-rules-v1',
    requiresHumanReview: false,
    reviewReasons: [],
    modelMetadata: { engine: 'quote-service', version: '1.0.0', deterministic: true },
    createdAt: NOW.toISOString(),
    ...overrides,
  };
  const integrityHash = signQuoteSnapshot(base, SECRET);
  return { ...base, integrityHash };
}

describe('signQuoteSnapshot / verifyQuoteIntegrity', () => {
  it('verifies a freshly-signed snapshot', () => {
    const snapshot = makeSnapshot();
    expect(verifyQuoteIntegrity(snapshot, SECRET)).toBe(true);
  });

  it('rejects a snapshot verified with the wrong secret', () => {
    const snapshot = makeSnapshot();
    expect(verifyQuoteIntegrity(snapshot, 'a-different-secret-entirely-123456')).toBe(false);
  });

  it('detects a mutated total ("tamper detection")', () => {
    const snapshot = makeSnapshot();
    const tampered = { ...snapshot, total: { minorUnits: 1, currency: 'AED' } };
    expect(verifyQuoteIntegrity(tampered, SECRET)).toBe(false);
  });

  it('detects a mutated line item amount', () => {
    const snapshot = makeSnapshot();
    const tampered = {
      ...snapshot,
      lineItems: [{ ...snapshot.lineItems[0]!, amount: { minorUnits: 1, currency: 'AED' } }],
    };
    expect(verifyQuoteIntegrity(tampered, SECRET)).toBe(false);
  });

  it('detects an added discount not present at signing time ("price manipulation")', () => {
    const snapshot = makeSnapshot();
    const tampered = {
      ...snapshot,
      discounts: [
        { code: 'FAKE', description: 'forged', amount: { minorUnits: 1_000_000, currency: 'AED' } },
      ],
    };
    expect(verifyQuoteIntegrity(tampered, SECRET)).toBe(false);
  });

  it('is unaffected by a change to requiresHumanReview/reviewReasons (not a price fact)', () => {
    const snapshot = makeSnapshot();
    const reviewed = { ...snapshot, requiresHumanReview: true, reviewReasons: ['flagged later'] };
    expect(verifyQuoteIntegrity(reviewed, SECRET)).toBe(true);
  });

  it('is unaffected by nested-object key reordering (simulating a jsonb round-trip)', () => {
    const snapshot = makeSnapshot();
    // Postgres jsonb does not preserve original key insertion order; a value
    // read back from the database can have its object keys in a different
    // order than what was originally signed, with identical content.
    const roundTripped: QuoteSnapshot = {
      ...snapshot,
      total: { currency: snapshot.total.currency, minorUnits: snapshot.total.minorUnits },
      deposit: { currency: snapshot.deposit.currency, minorUnits: snapshot.deposit.minorUnits },
      lineItems: snapshot.lineItems.map((item) => ({
        amount: item.amount,
        category: item.category,
        code: item.code,
        description: item.description,
        quantity: item.quantity,
        unitAmount: item.unitAmount,
      })),
    };
    expect(verifyQuoteIntegrity(roundTripped, SECRET)).toBe(true);
  });
});

describe('isQuoteExpired', () => {
  it('is false before validUntil', () => {
    const snapshot = makeSnapshot({ validUntil: new Date(NOW.getTime() + 1000).toISOString() });
    expect(isQuoteExpired(snapshot, NOW)).toBe(false);
  });

  it('is true at and after validUntil ("expired quote")', () => {
    const snapshot = makeSnapshot({ validUntil: NOW.toISOString() });
    expect(isQuoteExpired(snapshot, NOW)).toBe(true);
    expect(isQuoteExpired(snapshot, new Date(NOW.getTime() + 1))).toBe(true);
  });
});

describe('QuoteValidator', () => {
  const validator = new QuoteValidator(SECRET);

  it('passes for a valid, unexpired, untampered quote', () => {
    const snapshot = makeSnapshot({ validUntil: new Date(NOW.getTime() + 1000).toISOString() });
    expect(() => validator.validate(snapshot, NOW)).not.toThrow();
  });

  it('throws QUOTE_TAMPERED for a mutated snapshot', () => {
    const snapshot = makeSnapshot({ validUntil: new Date(NOW.getTime() + 1000).toISOString() });
    const tampered = { ...snapshot, total: { minorUnits: 1, currency: 'AED' } };
    try {
      validator.validate(tampered, NOW);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).details?.code).toBe('QUOTE_TAMPERED');
    }
  });

  it('throws QUOTE_EXPIRED for an expired but untampered quote', () => {
    const snapshot = makeSnapshot({ validUntil: NOW.toISOString() });
    try {
      validator.validate(snapshot, NOW);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).details?.code).toBe('QUOTE_EXPIRED');
    }
  });

  it('reports tamper before expiry when a quote is both tampered and expired', () => {
    const snapshot = makeSnapshot({ validUntil: NOW.toISOString() });
    const tampered = { ...snapshot, total: { minorUnits: 1, currency: 'AED' } };
    try {
      validator.validate(tampered, NOW);
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).details?.code).toBe('QUOTE_TAMPERED');
    }
  });
});
