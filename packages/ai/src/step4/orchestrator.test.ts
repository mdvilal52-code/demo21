import { describe, expect, it } from 'vitest';
import { MissingInfoOrchestrator } from './orchestrator.js';
import type { DateLocationSnapshot, VehicleSnapshot } from './requiredFieldsEvaluator.js';

const NOW = new Date('2026-09-17T12:00:00.000Z');

const DUBAI_MARINA = {
  raw: 'Dubai Marina',
  normalized: 'Dubai Marina',
  city: 'Dubai',
  country: 'AE',
  timezone: 'Asia/Dubai',
  locationType: 'CITY_AREA' as const,
};

const URUS = {
  id: '11111111-1111-1111-1111-111111111111',
  make: 'Lamborghini',
  model: 'Urus',
  category: 'SUV' as const,
  luxuryTier: 'ULTRA_LUXURY' as const,
  seats: 5,
  luggage: 4,
  transmission: 'AUTOMATIC' as const,
  availabilityStatus: 'AVAILABLE' as const,
  pricingProfile: { currency: 'AED', dailyRate: 3500 },
  active: true,
};

const COMPLETE_DATE_LOCATION: DateLocationSnapshot = {
  pickupDate: '2026-10-15T06:00:00.000Z',
  returnDate: '2026-10-19T06:00:00.000Z',
  pickupLocation: DUBAI_MARINA,
  dropoffLocation: null,
  ambiguities: [],
  validationErrors: [],
  promptInjectionDetected: false,
};

const RESOLVED_VEHICLE: VehicleSnapshot = {
  status: 'RESOLVED',
  resolvedVehicle: URUS,
  ambiguities: [],
  validationErrors: [],
  promptInjectionDetected: false,
};

function makeOrchestrator(): MissingInfoOrchestrator {
  return new MissingInfoOrchestrator();
}

describe('MissingInfoOrchestrator', () => {
  it('returns a COMPLETE, Zod-valid result with no clarification prompt', () => {
    const result = makeOrchestrator().evaluate({
      intent: { intentType: 'BOOKING_REQUEST', promptInjectionDetected: false },
      dateLocation: COMPLETE_DATE_LOCATION,
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('COMPLETE');
    expect(result.clarificationPrompt).toBeNull();
  });

  it('builds a combined clarification prompt for a NEEDS_INFO result', () => {
    const result = makeOrchestrator().evaluate({
      intent: { intentType: 'BOOKING_REQUEST', promptInjectionDetected: false },
      dateLocation: null,
      vehicle: null,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('NEEDS_INFO');
    expect(result.clarificationPrompt).toContain('pick up the car');
    expect(result.clarificationPrompt).toContain('vehicle');
  });

  it('never builds a clarification prompt for an EXPIRED result', () => {
    const createdAt = new Date('2026-09-15T00:00:00.000Z');
    const result = makeOrchestrator().evaluate({
      intent: { intentType: 'BOOKING_REQUEST', promptInjectionDetected: false },
      dateLocation: null,
      vehicle: null,
      conversationCreatedAt: createdAt,
      now: NOW,
    });
    expect(result.status).toBe('EXPIRED');
    expect(result.clarificationPrompt).toBeNull();
  });

  it('never builds a clarification prompt for a NOT_APPLICABLE result', () => {
    const result = makeOrchestrator().evaluate({
      intent: { intentType: 'SUPPORT_REQUEST', promptInjectionDetected: false },
      dateLocation: null,
      vehicle: null,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('NOT_APPLICABLE');
    expect(result.clarificationPrompt).toBeNull();
  });

  it('computes expiresAt as exactly 24h after the conversation was created', () => {
    const createdAt = new Date('2026-09-17T00:00:00.000Z');
    const result = makeOrchestrator().evaluate({
      intent: { intentType: 'BOOKING_REQUEST', promptInjectionDetected: false },
      dateLocation: null,
      vehicle: null,
      conversationCreatedAt: createdAt,
      now: NOW,
    });
    expect(result.expiresAt).toBe('2026-09-18T00:00:00.000Z');
  });

  it('surfaces the aggregated prompt-injection flag', () => {
    const result = makeOrchestrator().evaluate({
      intent: { intentType: 'BOOKING_REQUEST', promptInjectionDetected: true },
      dateLocation: COMPLETE_DATE_LOCATION,
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.flags.promptInjectionDetectedAnywhere).toBe(true);
  });
});
