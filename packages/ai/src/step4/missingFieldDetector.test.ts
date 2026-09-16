import { describe, expect, it } from 'vitest';
import type { MissingInfoAnswer } from '@ai-concierge/domain';
import { MissingFieldDetector } from './missingFieldDetector.js';
import type { FieldRequirementContext } from './fieldRequirementRules.js';

const hotelLocation = {
  raw: 'Atlantis The Palm',
  normalized: 'Atlantis The Palm',
  city: 'Dubai',
  country: 'AE',
  timezone: 'Asia/Dubai',
  locationType: 'HOTEL' as const,
};

const airportLocation = { ...hotelLocation, locationType: 'AIRPORT' as const };

const answer = (field: string, value: string | boolean): MissingInfoAnswer =>
  ({
    field,
    value,
    source: 'CUSTOMER_REPLY',
    answeredAt: '2026-09-16T10:00:00.000Z',
    corrected: false,
  }) as MissingInfoAnswer;

describe('MissingFieldDetector', () => {
  const detector = new MissingFieldDetector();

  it('reports every applicable field as missing when nothing is known yet', () => {
    const context: FieldRequirementContext = {
      pickupLocation: airportLocation,
      dropoffLocation: null,
      channel: 'WEB',
      driverRequirementKnownFromStep1: false,
    };

    const { missingFields, unansweredOptionalFields } = detector.detect({ context, answers: [] });

    expect(missingFields).toEqual(
      expect.arrayContaining([
        'DRIVER_REQUIREMENT',
        'FLIGHT_NUMBER',
        'PICKUP_TIME',
        'DROPOFF_ADDRESS',
        'CONTACT_DETAILS',
      ]),
    );
    expect(missingFields).not.toContain('SPECIAL_REQUESTS');
    expect(unansweredOptionalFields).toEqual(['SPECIAL_REQUESTS']);
  });

  it('reports nothing missing once every applicable field has an answer', () => {
    const context: FieldRequirementContext = {
      pickupLocation: hotelLocation,
      dropoffLocation: hotelLocation,
      channel: 'WHATSAPP',
      driverRequirementKnownFromStep1: true,
    };

    const { missingFields } = detector.detect({
      context,
      answers: [answer('DRIVER_REQUIREMENT', true), answer('PICKUP_TIME', '15:00')],
    });

    expect(missingFields).toEqual([]);
  });

  it('never re-reports a field that already has an answer, even a stale-looking one', () => {
    const context: FieldRequirementContext = {
      pickupLocation: airportLocation,
      dropoffLocation: hotelLocation,
      channel: 'WEB',
      driverRequirementKnownFromStep1: false,
    };

    const { missingFields } = detector.detect({
      context,
      answers: [
        answer('FLIGHT_NUMBER', 'EK203'),
        answer('PICKUP_TIME', '10:00'),
        answer('DRIVER_REQUIREMENT', false),
        answer('CONTACT_DETAILS', 'jane@example.com'),
      ],
    });

    expect(missingFields).toEqual([]);
  });

  it('reports exactly one missing field when only pickup time is unknown', () => {
    const context: FieldRequirementContext = {
      pickupLocation: hotelLocation,
      dropoffLocation: hotelLocation,
      channel: 'WHATSAPP',
      driverRequirementKnownFromStep1: true,
    };

    const { missingFields } = detector.detect({
      context,
      answers: [answer('DRIVER_REQUIREMENT', true)],
    });

    expect(missingFields).toEqual(['PICKUP_TIME']);
  });

  it('never reports CONTACT_DETAILS for a WhatsApp or Email conversation', () => {
    for (const channel of ['WHATSAPP', 'EMAIL'] as const) {
      const context: FieldRequirementContext = {
        pickupLocation: hotelLocation,
        dropoffLocation: hotelLocation,
        channel,
        driverRequirementKnownFromStep1: true,
      };
      const { missingFields } = detector.detect({
        context,
        answers: [answer('DRIVER_REQUIREMENT', true), answer('PICKUP_TIME', '10:00')],
      });
      expect(missingFields).not.toContain('CONTACT_DETAILS');
    }
  });
});
