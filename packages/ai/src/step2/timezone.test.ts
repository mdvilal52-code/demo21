import { describe, expect, it } from 'vitest';
import { isValidIanaTimeZone, zonedTimeToUtc } from './timezone.js';

describe('zonedTimeToUtc', () => {
  it('converts a Dubai (UTC+4, no DST) wall-clock time to the correct UTC instant', () => {
    const utc = zonedTimeToUtc(2026, 9, 15, 10, 0, 0, 'Asia/Dubai');
    expect(utc.toISOString()).toBe('2026-10-15T06:00:00.000Z');
  });

  it('round-trips midnight correctly', () => {
    const utc = zonedTimeToUtc(2026, 0, 1, 0, 0, 0, 'Asia/Dubai');
    expect(utc.toISOString()).toBe('2025-12-31T20:00:00.000Z');
  });

  it('is DST-aware for a zone that observes it (America/New_York, summer = UTC-4)', () => {
    const summer = zonedTimeToUtc(2026, 6, 15, 12, 0, 0, 'America/New_York');
    expect(summer.toISOString()).toBe('2026-07-15T16:00:00.000Z');
  });

  it('is DST-aware for a zone that observes it (America/New_York, winter = UTC-5)', () => {
    const winter = zonedTimeToUtc(2026, 0, 15, 12, 0, 0, 'America/New_York');
    expect(winter.toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });
});

describe('isValidIanaTimeZone', () => {
  it('accepts a real IANA zone', () => {
    expect(isValidIanaTimeZone('Asia/Dubai')).toBe(true);
  });

  it('rejects a bogus zone name', () => {
    expect(isValidIanaTimeZone('Not/AZone')).toBe(false);
  });
});
