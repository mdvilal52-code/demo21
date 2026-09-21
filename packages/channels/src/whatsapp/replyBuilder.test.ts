import { MissingInfoStatus, type MissingInfoResult } from '@ai-concierge/domain';
import { describe, expect, it } from 'vitest';
import { buildWhatsAppReplyText } from './replyBuilder.js';

function baseResult(overrides: Partial<MissingInfoResult> = {}): MissingInfoResult {
  return {
    status: MissingInfoStatus.NEEDS_INFO,
    collected: {
      pickupDate: null,
      returnDate: null,
      pickupLocation: null,
      dropoffLocation: null,
      vehicle: null,
    },
    missingFields: [],
    clarificationPrompt: null,
    expiresAt: new Date().toISOString(),
    flags: { promptInjectionDetectedAnywhere: false },
    modelMetadata: { engine: 'test', version: '0.1.0', deterministic: true },
    ...overrides,
  };
}

describe('buildWhatsAppReplyText', () => {
  it('uses the exact clarification prompt for NEEDS_INFO', () => {
    const text = buildWhatsAppReplyText(
      baseResult({ status: MissingInfoStatus.NEEDS_INFO, clarificationPrompt: 'Which dates?' }),
    );
    expect(text).toBe('Which dates?');
  });

  it('summarizes what was collected for COMPLETE', () => {
    const text = buildWhatsAppReplyText(
      baseResult({
        status: MissingInfoStatus.COMPLETE,
        collected: {
          pickupDate: '2026-10-15T00:00:00.000Z',
          returnDate: '2026-10-19T00:00:00.000Z',
          pickupLocation: {
            raw: 'Dubai',
            normalized: 'Dubai',
            city: 'Dubai',
            country: 'AE',
            timezone: 'Asia/Dubai',
            locationType: 'CITY_AREA',
          },
          dropoffLocation: null,
          vehicle: {
            id: '00000000-0000-0000-0000-000000000009',
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
      }),
    );
    expect(text).toContain('Lamborghini Urus');
    expect(text).toContain('2026-10-15 to 2026-10-19');
    expect(text).toContain('Dubai');
    expect(text).toMatch(/quote/i);
  });

  it('gives a distinct message for EXPIRED', () => {
    expect(buildWhatsAppReplyText(baseResult({ status: MissingInfoStatus.EXPIRED }))).toMatch(
      /resend|start fresh/i,
    );
  });

  it('gives a distinct message for NOT_APPLICABLE', () => {
    expect(
      buildWhatsAppReplyText(baseResult({ status: MissingInfoStatus.NOT_APPLICABLE })),
    ).toMatch(/book a car/i);
  });

  it('gives a distinct acknowledgement message for CANCELLED', () => {
    const text = buildWhatsAppReplyText(baseResult({ status: MissingInfoStatus.CANCELLED }));
    expect(text).toMatch(/cancel/i);
    // Never confusable with any other status's copy.
    expect(text).not.toMatch(/book a car and we'll take it from there/i);
    expect(text).not.toMatch(/quote/i);
  });

  it('falls back to a generic message if NEEDS_INFO somehow has no prompt', () => {
    const text = buildWhatsAppReplyText(
      baseResult({ status: MissingInfoStatus.NEEDS_INFO, clarificationPrompt: null }),
    );
    expect(text.length).toBeGreaterThan(0);
  });
});
