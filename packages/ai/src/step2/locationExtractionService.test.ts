import { describe, expect, it } from 'vitest';
import { GazetteerLocationProvider } from './gazetteerLocationProvider.js';
import { LocationExtractionService } from './locationExtractionService.js';

const service = new LocationExtractionService(new GazetteerLocationProvider());

describe('LocationExtractionService', () => {
  it('resolves a single mentioned location as pickup only', async () => {
    const result = await service.extract('I want to rent a car in Dubai Marina');
    expect(result.pickupLocation?.normalized).toBe('Dubai Marina');
    expect(result.dropoffLocation).toBeNull();
    expect(result.ambiguities).toEqual([]);
  });

  it('assigns pickup and dropoff in reading order for a "from X to Y" message', async () => {
    const result = await service.extract(
      'pick up from Dubai Marina and drop off at Dubai International Airport',
    );
    expect(result.pickupLocation?.normalized).toBe('Dubai Marina');
    expect(result.dropoffLocation?.normalized).toBe('Dubai International Airport');
  });

  it('flags 3+ candidate locations as ambiguous while still picking the first two', async () => {
    const result = await service.extract('Dubai Marina, then Business Bay, then Downtown Dubai');
    expect(result.ambiguities.some((a) => a.code === 'MULTIPLE_CANDIDATE_LOCATIONS')).toBe(true);
    expect(result.pickupLocation?.normalized).toBe('Dubai Marina');
    expect(result.dropoffLocation?.normalized).toBe('Business Bay');
  });

  it('returns nulls with no ambiguity when no location is mentioned at all', async () => {
    const result = await service.extract('I want to rent a car for the weekend');
    expect(result.pickupLocation).toBeNull();
    expect(result.dropoffLocation).toBeNull();
    expect(result.ambiguities).toEqual([]);
  });

  it('flags a genuinely unrecognized location phrase as ambiguous', async () => {
    const result = await service.extract('I want to pick up the car in Narnialand');
    expect(result.pickupLocation).toBeNull();
    expect(result.ambiguities).toContainEqual(
      expect.objectContaining({ code: 'UNRECOGNIZED_LOCATION_TEXT', raw: 'Narnialand' }),
    );
  });

  it('distinguishes a known city outside the service area from a truly unrecognized one', async () => {
    const result = await service.extract('I want to pick up the car in London');
    expect(result.pickupLocation).toBeNull();
    expect(result.unsupportedLocationMentions).toContain('London');
    expect(result.ambiguities.some((a) => a.code === 'UNRECOGNIZED_LOCATION_TEXT')).toBe(false);
  });

  it('never flags a location phrase that was actually resolved', async () => {
    const result = await service.extract('pick up in Dubai Marina');
    expect(result.ambiguities).toEqual([]);
  });
});
