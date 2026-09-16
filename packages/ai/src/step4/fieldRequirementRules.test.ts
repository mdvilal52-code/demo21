import { describe, expect, it } from 'vitest';
import { isFieldRequired, type FieldRequirementContext } from './fieldRequirementRules.js';

const hotelLocation = {
  raw: 'Atlantis The Palm',
  normalized: 'Atlantis The Palm',
  city: 'Dubai',
  country: 'AE',
  timezone: 'Asia/Dubai',
  locationType: 'HOTEL' as const,
};

const airportLocation = { ...hotelLocation, locationType: 'AIRPORT' as const };
const cityAreaLocation = { ...hotelLocation, locationType: 'CITY_AREA' as const };

const baseContext: FieldRequirementContext = {
  pickupLocation: hotelLocation,
  dropoffLocation: hotelLocation,
  channel: 'WHATSAPP',
  driverRequirementKnownFromStep1: true,
};

describe('isFieldRequired — FLIGHT_NUMBER', () => {
  it('is required when pickup is an airport', () => {
    expect(
      isFieldRequired('FLIGHT_NUMBER', { ...baseContext, pickupLocation: airportLocation }),
    ).toBe(true);
  });

  it('is not required when pickup is a hotel', () => {
    expect(isFieldRequired('FLIGHT_NUMBER', baseContext)).toBe(false);
  });

  it('is not required when pickup location is unknown', () => {
    expect(isFieldRequired('FLIGHT_NUMBER', { ...baseContext, pickupLocation: null })).toBe(false);
  });
});

describe('isFieldRequired — DROPOFF_ADDRESS', () => {
  it('is not required when dropoff already resolved to a precise hotel', () => {
    expect(isFieldRequired('DROPOFF_ADDRESS', baseContext)).toBe(false);
  });

  it('is not required when dropoff is the airport', () => {
    expect(
      isFieldRequired('DROPOFF_ADDRESS', { ...baseContext, dropoffLocation: airportLocation }),
    ).toBe(false);
  });

  it('is required when dropoff is only a vague city area', () => {
    expect(
      isFieldRequired('DROPOFF_ADDRESS', { ...baseContext, dropoffLocation: cityAreaLocation }),
    ).toBe(true);
  });

  it('is required when dropoff was never resolved', () => {
    expect(isFieldRequired('DROPOFF_ADDRESS', { ...baseContext, dropoffLocation: null })).toBe(
      true,
    );
  });
});

describe('isFieldRequired — PICKUP_TIME', () => {
  it('is always required (Step 2 never extracts a real clock time)', () => {
    expect(isFieldRequired('PICKUP_TIME', baseContext)).toBe(true);
  });
});

describe('isFieldRequired — DRIVER_REQUIREMENT', () => {
  it('is not required once Step 1 already captured it', () => {
    expect(isFieldRequired('DRIVER_REQUIREMENT', baseContext)).toBe(false);
  });

  it('is required when Step 1 never captured it', () => {
    expect(
      isFieldRequired('DRIVER_REQUIREMENT', {
        ...baseContext,
        driverRequirementKnownFromStep1: false,
      }),
    ).toBe(true);
  });
});

describe('isFieldRequired — CONTACT_DETAILS', () => {
  it('is required for the WEB channel (no reachable identity from the channel itself)', () => {
    expect(isFieldRequired('CONTACT_DETAILS', { ...baseContext, channel: 'WEB' })).toBe(true);
  });

  it('is not required for WHATSAPP (customerRef is already a phone number)', () => {
    expect(isFieldRequired('CONTACT_DETAILS', { ...baseContext, channel: 'WHATSAPP' })).toBe(false);
  });

  it('is not required for EMAIL (customerRef is already an email address)', () => {
    expect(isFieldRequired('CONTACT_DETAILS', { ...baseContext, channel: 'EMAIL' })).toBe(false);
  });
});

describe('isFieldRequired — SPECIAL_REQUESTS', () => {
  it('is never required', () => {
    expect(isFieldRequired('SPECIAL_REQUESTS', baseContext)).toBe(false);
  });
});
