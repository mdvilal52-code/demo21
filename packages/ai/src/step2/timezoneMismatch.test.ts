import { describe, expect, it } from 'vitest';
import { findExplicitTimezoneMention, getUtcOffsetMinutesAt } from './timezoneMismatch.js';

describe('findExplicitTimezoneMention', () => {
  it('detects a common abbreviation', () => {
    expect(findExplicitTimezoneMention('pickup at 3pm EST')).toEqual({
      raw: 'EST',
      offsetMinutes: -300,
    });
  });

  it('detects an explicit UTC offset', () => {
    expect(findExplicitTimezoneMention('pickup at UTC+4')).toEqual({
      raw: 'UTC+4',
      offsetMinutes: 240,
    });
  });

  it('detects a negative explicit offset with minutes', () => {
    expect(findExplicitTimezoneMention('meet at GMT-05:30')).toEqual({
      raw: 'GMT-05:30',
      offsetMinutes: -330,
    });
  });

  it('returns null when no timezone is mentioned', () => {
    expect(findExplicitTimezoneMention('pickup at Dubai Marina tomorrow')).toBeNull();
  });
});

describe('getUtcOffsetMinutesAt', () => {
  it('returns +240 for Asia/Dubai year-round (no DST)', () => {
    expect(getUtcOffsetMinutesAt(new Date('2026-01-15T00:00:00Z'), 'Asia/Dubai')).toBe(240);
    expect(getUtcOffsetMinutesAt(new Date('2026-07-15T00:00:00Z'), 'Asia/Dubai')).toBe(240);
  });

  it('returns the correct DST-aware offset for a zone that observes it', () => {
    expect(getUtcOffsetMinutesAt(new Date('2026-01-15T00:00:00Z'), 'America/New_York')).toBe(-300);
    expect(getUtcOffsetMinutesAt(new Date('2026-07-15T00:00:00Z'), 'America/New_York')).toBe(-240);
  });
});
