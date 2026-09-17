import { describe, expect, it } from 'vitest';
import { missingInfoResultSchema } from './missingInfo.js';

const emptyCollected = {
  pickupDate: null,
  returnDate: null,
  pickupLocation: null,
  dropoffLocation: null,
  vehicle: null,
};

const baseFlags = { promptInjectionDetectedAnywhere: false };
const baseMetadata = { engine: 'missing-info-evaluator-v1', version: '0.1.0', deterministic: true };

describe('missingInfoResultSchema', () => {
  it('accepts a COMPLETE result with nothing missing and no prompt', () => {
    const result = missingInfoResultSchema.safeParse({
      status: 'COMPLETE',
      collected: {
        ...emptyCollected,
        pickupDate: '2026-10-15T06:00:00.000Z',
        returnDate: '2026-10-19T06:00:00.000Z',
      },
      missingFields: [],
      clarificationPrompt: null,
      expiresAt: '2026-09-18T00:00:00.000Z',
      flags: baseFlags,
      modelMetadata: baseMetadata,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a NEEDS_INFO result with missing fields and a prompt', () => {
    const result = missingInfoResultSchema.safeParse({
      status: 'NEEDS_INFO',
      collected: emptyCollected,
      missingFields: [
        { field: 'PICKUP_DATE', reason: 'NOT_PROVIDED' },
        { field: 'VEHICLE', reason: 'AMBIGUOUS', detail: '2 vehicles matched; please choose one' },
      ],
      clarificationPrompt: 'Could you please confirm when you would like to pick up the car?',
      expiresAt: '2026-09-18T00:00:00.000Z',
      flags: baseFlags,
      modelMetadata: baseMetadata,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a NOT_APPLICABLE result for a non-booking intent', () => {
    const result = missingInfoResultSchema.safeParse({
      status: 'NOT_APPLICABLE',
      collected: emptyCollected,
      missingFields: [],
      clarificationPrompt: null,
      expiresAt: '2026-09-18T00:00:00.000Z',
      flags: baseFlags,
      modelMetadata: baseMetadata,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status value', () => {
    const result = missingInfoResultSchema.safeParse({
      status: 'IN_PROGRESS',
      collected: emptyCollected,
      missingFields: [],
      clarificationPrompt: null,
      expiresAt: '2026-09-18T00:00:00.000Z',
      flags: baseFlags,
      modelMetadata: baseMetadata,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown missing-field reason', () => {
    const result = missingInfoResultSchema.safeParse({
      status: 'NEEDS_INFO',
      collected: emptyCollected,
      missingFields: [{ field: 'PICKUP_DATE', reason: 'UNKNOWABLE' }],
      clarificationPrompt: 'x',
      expiresAt: '2026-09-18T00:00:00.000Z',
      flags: baseFlags,
      modelMetadata: baseMetadata,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO expiresAt', () => {
    const result = missingInfoResultSchema.safeParse({
      status: 'COMPLETE',
      collected: emptyCollected,
      missingFields: [],
      clarificationPrompt: null,
      expiresAt: '18 Sep 2026',
      flags: baseFlags,
      modelMetadata: baseMetadata,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a fully populated resolved vehicle inside collected', () => {
    const result = missingInfoResultSchema.safeParse({
      status: 'COMPLETE',
      collected: {
        ...emptyCollected,
        pickupDate: '2026-10-15T06:00:00.000Z',
        returnDate: '2026-10-19T06:00:00.000Z',
        pickupLocation: {
          raw: 'Dubai Marina',
          normalized: 'Dubai Marina',
          city: 'Dubai',
          country: 'AE',
          timezone: 'Asia/Dubai',
          locationType: 'CITY_AREA',
        },
        vehicle: {
          id: '11111111-1111-1111-1111-111111111111',
          make: 'Lamborghini',
          model: 'Urus',
          category: 'SUV',
          luxuryTier: 'ULTRA_LUXURY',
          seats: 5,
          luggage: 4,
          transmission: 'AUTOMATIC',
          availabilityStatus: 'AVAILABLE',
          pricingProfile: { currency: 'AED', dailyRate: 3500 },
          active: true,
        },
      },
      missingFields: [],
      clarificationPrompt: null,
      expiresAt: '2026-09-18T00:00:00.000Z',
      flags: baseFlags,
      modelMetadata: baseMetadata,
    });
    expect(result.success).toBe(true);
  });
});
