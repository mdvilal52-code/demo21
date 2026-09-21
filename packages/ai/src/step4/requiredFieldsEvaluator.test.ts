import type { Vehicle } from '@ai-concierge/domain';
import { describe, expect, it } from 'vitest';
import {
  RequiredFieldsEvaluator,
  type DateLocationSnapshot,
  type IntentSnapshot,
  type VehicleSnapshot,
} from './requiredFieldsEvaluator.js';

const NOW = new Date('2026-09-17T12:00:00.000Z');

const BOOKING_INTENT: IntentSnapshot = {
  intentType: 'BOOKING_REQUEST',
  promptInjectionDetected: false,
};

const DUBAI_MARINA = {
  raw: 'Dubai Marina',
  normalized: 'Dubai Marina',
  city: 'Dubai',
  country: 'AE',
  timezone: 'Asia/Dubai',
  locationType: 'CITY_AREA' as const,
};

const URUS: Vehicle = {
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

function makeEvaluator(): RequiredFieldsEvaluator {
  return new RequiredFieldsEvaluator();
}

describe('RequiredFieldsEvaluator', () => {
  it('is NOT_APPLICABLE when the intent is not a booking request', () => {
    const result = makeEvaluator().evaluate({
      intent: { intentType: 'PRICE_REQUEST', promptInjectionDetected: false },
      dateLocation: null,
      vehicle: null,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('NOT_APPLICABLE');
    expect(result.missingFields).toEqual([]);
  });

  it('is NOT_APPLICABLE for a non-booking intent when nothing has been collected yet', () => {
    const result = makeEvaluator().evaluate({
      intent: { intentType: 'DOCUMENT_REQUEST', promptInjectionDetected: false },
      dateLocation: null,
      vehicle: null,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('NOT_APPLICABLE');
  });

  it('still proceeds (does not discard progress) for a non-booking intent once a vehicle is already resolved', () => {
    // e.g. "what documents do I need?" mid-booking: Step 1 classifies this
    // turn as DOCUMENT_REQUEST, but Steps 2-3 already resolved a vehicle for
    // this conversation on an earlier turn — losing that to NOT_APPLICABLE
    // would silently reset an in-progress booking.
    const result = makeEvaluator().evaluate({
      intent: { intentType: 'DOCUMENT_REQUEST', promptInjectionDetected: false },
      dateLocation: null,
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('NEEDS_INFO');
    expect(result.collected.vehicle).toEqual(URUS);
    expect(result.missingFields).toEqual(
      expect.arrayContaining([
        { field: 'PICKUP_DATE', reason: 'NOT_PROVIDED' },
        { field: 'RETURN_DATE', reason: 'NOT_PROVIDED' },
        { field: 'PICKUP_LOCATION', reason: 'NOT_PROVIDED' },
      ]),
    );
  });

  it('still proceeds for a non-booking intent once a pickup date is already resolved', () => {
    const result = makeEvaluator().evaluate({
      intent: { intentType: 'SUPPORT_REQUEST', promptInjectionDetected: false },
      dateLocation: { ...COMPLETE_DATE_LOCATION, pickupLocation: null },
      vehicle: null,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('NEEDS_INFO');
    expect(result.collected.pickupDate).toBe('2026-10-15T06:00:00.000Z');
  });

  it('is NOT_APPLICABLE for a non-booking intent when a vehicle was only ambiguously matched, not resolved', () => {
    // An unresolved attempt is not "collected" data — nothing would be lost
    // by staying NOT_APPLICABLE, so the gate does not treat it as progress.
    const result = makeEvaluator().evaluate({
      intent: { intentType: 'PRICE_REQUEST', promptInjectionDetected: false },
      dateLocation: null,
      vehicle: {
        status: 'NEEDS_CLARIFICATION',
        resolvedVehicle: null,
        ambiguities: [
          { field: 'vehicle', code: 'CATEGORY_ONLY_MULTIPLE_MATCHES', message: 'pick one' },
        ],
        validationErrors: [],
        promptInjectionDetected: false,
      },
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('NOT_APPLICABLE');
  });

  it('is CANCELLED when the customer cancels a booking that has real progress', () => {
    const result = makeEvaluator().evaluate({
      intent: { intentType: 'CANCEL_REQUEST', promptInjectionDetected: false },
      dateLocation: null,
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('CANCELLED');
    expect(result.collected.vehicle).toEqual(URUS);
    expect(result.missingFields).toEqual([]);
  });

  it('is CANCELLED even once the booking was already COMPLETE — cancellation wins', () => {
    const result = makeEvaluator().evaluate({
      intent: { intentType: 'CANCEL_REQUEST', promptInjectionDetected: false },
      dateLocation: COMPLETE_DATE_LOCATION,
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('CANCELLED');
  });

  it('is NOT_APPLICABLE for a cancel request when there was never anything to cancel', () => {
    const result = makeEvaluator().evaluate({
      intent: { intentType: 'CANCEL_REQUEST', promptInjectionDetected: false },
      dateLocation: null,
      vehicle: null,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('NOT_APPLICABLE');
  });

  it('is NOT_APPLICABLE when no intent has been recognized at all', () => {
    const result = makeEvaluator().evaluate({
      intent: null,
      dateLocation: null,
      vehicle: null,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('NOT_APPLICABLE');
  });

  it('is COMPLETE when every required field is resolved', () => {
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: COMPLETE_DATE_LOCATION,
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('COMPLETE');
    expect(result.missingFields).toEqual([]);
    expect(result.collected.pickupDate).toBe('2026-10-15T06:00:00.000Z');
    expect(result.collected.vehicle).toEqual(URUS);
  });

  it('does not require a dropoff location for completeness', () => {
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: { ...COMPLETE_DATE_LOCATION, dropoffLocation: null },
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('COMPLETE');
  });

  it('reports NOT_PROVIDED for a field when the underlying step never ran at all', () => {
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: null,
      vehicle: null,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.status).toBe('NEEDS_INFO');
    expect(result.missingFields).toEqual(
      expect.arrayContaining([
        { field: 'PICKUP_DATE', reason: 'NOT_PROVIDED' },
        { field: 'RETURN_DATE', reason: 'NOT_PROVIDED' },
        { field: 'PICKUP_LOCATION', reason: 'NOT_PROVIDED' },
        { field: 'VEHICLE', reason: 'NOT_PROVIDED' },
      ]),
    );
    expect(result.missingFields).toHaveLength(4);
  });

  it('reports AMBIGUOUS for a date Step 2 flagged as ambiguous', () => {
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: {
        ...COMPLETE_DATE_LOCATION,
        pickupDate: null,
        ambiguities: [
          {
            field: 'pickupDate',
            code: 'AMBIGUOUS_NUMERIC_DATE',
            message: '"10/11/26" could be read as either 10 Nov or 11 Oct',
          },
        ],
      },
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.missingFields).toEqual([
      {
        field: 'PICKUP_DATE',
        reason: 'AMBIGUOUS',
        detail: '"10/11/26" could be read as either 10 Nov or 11 Oct',
      },
    ]);
  });

  it('reports INVALID for a date Step 2 rejected (e.g. past date), preferring it over an ambiguity', () => {
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: {
        ...COMPLETE_DATE_LOCATION,
        pickupDate: null,
        validationErrors: [
          {
            field: 'pickupDate',
            code: 'PAST_DATE',
            message: 'Pickup date is in the past',
            severity: 'ERROR',
          },
        ],
      },
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.missingFields).toEqual([
      { field: 'PICKUP_DATE', reason: 'INVALID', detail: 'Pickup date is in the past' },
    ]);
  });

  it('reports INVALID for an unsupported pickup location', () => {
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: {
        ...COMPLETE_DATE_LOCATION,
        pickupLocation: null,
        validationErrors: [
          {
            field: 'pickupLocation',
            code: 'UNSUPPORTED_LOCATION',
            message: '"London" is a recognized city outside the current service area',
            severity: 'ERROR',
          },
        ],
      },
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.missingFields).toEqual([
      {
        field: 'PICKUP_LOCATION',
        reason: 'INVALID',
        detail: '"London" is a recognized city outside the current service area',
      },
    ]);
  });

  it('reports AMBIGUOUS for a vehicle Step 3 could not resolve unambiguously', () => {
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: COMPLETE_DATE_LOCATION,
      vehicle: {
        status: 'NEEDS_CLARIFICATION',
        resolvedVehicle: null,
        ambiguities: [
          {
            field: 'vehicle',
            code: 'CATEGORY_ONLY_MULTIPLE_MATCHES',
            message: '2 vehicles matched; please choose one',
          },
        ],
        validationErrors: [],
        promptInjectionDetected: false,
      },
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.missingFields).toEqual([
      { field: 'VEHICLE', reason: 'AMBIGUOUS', detail: '2 vehicles matched; please choose one' },
    ]);
  });

  it('reports INVALID for a vehicle Step 3 could not fulfill', () => {
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: COMPLETE_DATE_LOCATION,
      vehicle: {
        status: 'UNSUPPORTED',
        resolvedVehicle: null,
        ambiguities: [],
        validationErrors: [
          {
            field: 'vehicle',
            code: 'VEHICLE_INACTIVE',
            message: 'Bentley Continental is not currently offered',
            severity: 'ERROR',
          },
        ],
        promptInjectionDetected: false,
      },
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.missingFields).toEqual([
      {
        field: 'VEHICLE',
        reason: 'INVALID',
        detail: 'Bentley Continental is not currently offered',
      },
    ]);
  });

  it('is EXPIRED when still incomplete after the 24h window', () => {
    const createdAt = new Date('2026-09-15T00:00:00.000Z'); // 60h before NOW
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: null,
      vehicle: null,
      conversationCreatedAt: createdAt,
      now: NOW,
    });
    expect(result.status).toBe('EXPIRED');
    expect(result.missingFields.length).toBeGreaterThan(0);
  });

  it('is NEEDS_INFO (not EXPIRED) just under the 24h window', () => {
    const createdAt = new Date('2026-09-17T00:00:00.000Z'); // 12h before NOW
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: null,
      vehicle: null,
      conversationCreatedAt: createdAt,
      now: NOW,
    });
    expect(result.status).toBe('NEEDS_INFO');
  });

  it('is COMPLETE (never EXPIRED) even long after 24h once everything is resolved', () => {
    const createdAt = new Date('2026-09-01T00:00:00.000Z');
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: COMPLETE_DATE_LOCATION,
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: createdAt,
      now: NOW,
    });
    expect(result.status).toBe('COMPLETE');
  });

  it('aggregates promptInjectionDetected from any of the three sources', () => {
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: { ...COMPLETE_DATE_LOCATION, promptInjectionDetected: true },
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.promptInjectionDetectedAnywhere).toBe(true);
  });

  it('does not flag injection when none of the three sources detected it', () => {
    const result = makeEvaluator().evaluate({
      intent: BOOKING_INTENT,
      dateLocation: COMPLETE_DATE_LOCATION,
      vehicle: RESOLVED_VEHICLE,
      conversationCreatedAt: NOW,
      now: NOW,
    });
    expect(result.promptInjectionDetectedAnywhere).toBe(false);
  });
});
