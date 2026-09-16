import { describe, expect, it } from 'vitest';
import { GazetteerLocationProvider } from './gazetteerLocationProvider.js';

const provider = new GazetteerLocationProvider();

describe('GazetteerLocationProvider', () => {
  it('resolves a known Dubai area', async () => {
    const candidates = await provider.resolve('pickup at Dubai Marina please');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.normalized).toBe('Dubai Marina');
    expect(candidates[0]?.city).toBe('Dubai');
    expect(candidates[0]?.timezone).toBe('Asia/Dubai');
  });

  it('does not double-count a generic city name inside a more specific match', async () => {
    const candidates = await provider.resolve('I want a car in Dubai Marina');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.normalized).toBe('Dubai Marina');
  });

  it('finds two distinct locations in reading order', async () => {
    const candidates = await provider.resolve('from Dubai Marina to Dubai International Airport');
    expect(candidates.map((c) => c.normalized)).toEqual([
      'Dubai Marina',
      'Dubai International Airport',
    ]);
  });

  it('resolves an airport abbreviation', async () => {
    const candidates = await provider.resolve('drop off at DXB');
    expect(candidates[0]?.locationType).toBe('AIRPORT');
  });

  it('resolves a hotel by name', async () => {
    const candidates = await provider.resolve('meet me at Burj Al Arab');
    expect(candidates[0]?.locationType).toBe('HOTEL');
  });

  it('returns nothing for a message with no location mention', async () => {
    const candidates = await provider.resolve('I want to rent a car for the weekend');
    expect(candidates).toHaveLength(0);
  });

  it('is case-insensitive', async () => {
    const candidates = await provider.resolve('pick up in DUBAI MARINA');
    expect(candidates[0]?.normalized).toBe('Dubai Marina');
  });
});
