import { describe, expect, it } from 'vitest';
import { dateLocationExtractionResultSchema, normalizedLocationSchema } from './temporal.js';

const validLocation = {
  raw: 'Dubai Marina',
  normalized: 'Dubai Marina',
  city: 'Dubai',
  country: 'AE',
  timezone: 'Asia/Dubai',
  locationType: 'CITY_AREA',
};

describe('normalizedLocationSchema', () => {
  it('accepts a well-formed location', () => {
    expect(normalizedLocationSchema.safeParse(validLocation).success).toBe(true);
  });

  it('rejects a country code that is not 2 letters', () => {
    const result = normalizedLocationSchema.safeParse({ ...validLocation, country: 'UAE' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid locationType', () => {
    const result = normalizedLocationSchema.safeParse({
      ...validLocation,
      locationType: 'MOON_BASE',
    });
    expect(result.success).toBe(false);
  });
});

describe('dateLocationExtractionResultSchema', () => {
  const base = {
    pickupDate: null,
    returnDate: null,
    timezone: null,
    pickupLocation: null,
    dropoffLocation: null,
    locationType: null,
    confidence: 0.5,
    ambiguities: [],
    validationErrors: [],
    flags: { promptInjectionDetected: false },
    modelMetadata: { engine: 'rule-based-temporal-v1', version: '0.1.0', deterministic: true },
  };

  it('accepts an all-null result (nothing extracted)', () => {
    expect(dateLocationExtractionResultSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a fully populated result', () => {
    const result = dateLocationExtractionResultSchema.safeParse({
      ...base,
      pickupDate: '2026-10-15T06:00:00.000Z',
      returnDate: '2026-10-19T06:00:00.000Z',
      timezone: 'Asia/Dubai',
      pickupLocation: validLocation,
      dropoffLocation: validLocation,
      locationType: 'CITY_AREA',
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-ISO pickupDate', () => {
    const result = dateLocationExtractionResultSchema.safeParse({
      ...base,
      pickupDate: '15 October 2026',
    });
    expect(result.success).toBe(false);
  });

  it('rejects confidence outside 0..1', () => {
    const result = dateLocationExtractionResultSchema.safeParse({ ...base, confidence: 1.5 });
    expect(result.success).toBe(false);
  });

  it('accepts a populated ambiguities/validationErrors list', () => {
    const result = dateLocationExtractionResultSchema.safeParse({
      ...base,
      ambiguities: [
        {
          field: 'pickupDate',
          code: 'AMBIGUOUS_NUMERIC_DATE',
          message: 'could be DD/MM or MM/DD',
          raw: '10/11/26',
        },
      ],
      validationErrors: [
        {
          field: 'returnDate',
          code: 'RETURN_BEFORE_OR_EQUAL_PICKUP',
          message: 'return must be after pickup',
          severity: 'ERROR',
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
