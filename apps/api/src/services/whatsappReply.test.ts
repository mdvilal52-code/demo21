import { describe, expect, it } from 'vitest';
import type { MissingInfoResult } from '@ai-concierge/domain';
import { buildWhatsAppReplyText } from './whatsappReply.js';

const base = {
  missingFields: [],
  expiresAt: '2026-09-20T00:00:00.000Z',
  flags: { promptInjectionDetectedAnywhere: false },
  modelMetadata: { engine: 'missing-info-evaluator-v1', version: '0.1.0', deterministic: true },
};

const emptyCollected: MissingInfoResult['collected'] = {
  pickupDate: null,
  returnDate: null,
  pickupLocation: null,
  dropoffLocation: null,
  vehicle: null,
};

describe('buildWhatsAppReplyText', () => {
  it('returns the clarification prompt verbatim for NEEDS_INFO', () => {
    const result: MissingInfoResult = {
      ...base,
      status: 'NEEDS_INFO',
      collected: emptyCollected,
      clarificationPrompt: 'Could you confirm your pickup date?',
    };
    expect(buildWhatsAppReplyText(result)).toBe('Could you confirm your pickup date?');
  });

  it('summarizes what was collected for COMPLETE', () => {
    const result: MissingInfoResult = {
      ...base,
      status: 'COMPLETE',
      clarificationPrompt: null,
      collected: {
        pickupDate: '2026-10-15T00:00:00.000Z',
        returnDate: '2026-10-19T00:00:00.000Z',
        pickupLocation: {
          raw: 'Dubai Marina',
          normalized: 'Dubai Marina, Dubai',
          city: 'Dubai',
          country: 'AE',
          timezone: 'Asia/Dubai',
          locationType: 'CITY_AREA',
        },
        dropoffLocation: null,
        vehicle: {
          id: '00000000-0000-0000-0000-0000000000aa',
          make: 'Lamborghini',
          model: 'Urus',
          category: 'SUV',
          luxuryTier: 'ULTRA_LUXURY',
          seats: 5,
          luggage: 2,
          transmission: 'AUTOMATIC',
          availabilityStatus: 'AVAILABLE',
          pricingProfile: { currency: 'AED', dailyRate: 5000 },
          active: true,
        },
      },
    };
    const text = buildWhatsAppReplyText(result);
    expect(text).toContain('Lamborghini Urus');
    expect(text).toContain('Dubai Marina, Dubai');
    expect(text).toContain('follow up');
  });

  it('handles COMPLETE with a partially-empty collected summary gracefully', () => {
    const result: MissingInfoResult = {
      ...base,
      status: 'COMPLETE',
      clarificationPrompt: null,
      collected: emptyCollected,
    };
    expect(buildWhatsAppReplyText(result)).toMatch(/got everything we need/);
  });

  it('returns an expiry message for EXPIRED', () => {
    const result: MissingInfoResult = {
      ...base,
      status: 'EXPIRED',
      clarificationPrompt: null,
      collected: emptyCollected,
    };
    expect(buildWhatsAppReplyText(result)).toMatch(/expired/i);
  });

  it('returns a generic acknowledgment for NOT_APPLICABLE', () => {
    const result: MissingInfoResult = {
      ...base,
      status: 'NOT_APPLICABLE',
      clarificationPrompt: null,
      collected: emptyCollected,
    };
    expect(buildWhatsAppReplyText(result)).toMatch(/team members will get back/);
  });
});
