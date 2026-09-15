import { describe, expect, it } from 'vitest';
import { extractDates } from './dates.js';

const REFERENCE_DATE = new Date('2026-09-01T09:00:00.000Z');

describe('extractDates', () => {
  it('parses a "DD Month" pickup date and rolls the year forward if in the past', () => {
    const { pickupDate } = extractDates('I need it on 15 October', REFERENCE_DATE);
    expect(pickupDate?.toISOString()).toContain('2026-10-15');
  });

  it('rolls to next year when the day/month has already passed this year', () => {
    const { pickupDate } = extractDates('pickup on 15 January', REFERENCE_DATE);
    expect(pickupDate?.toISOString()).toContain('2027-01-15');
  });

  it('parses a same-month day range as pickup and return', () => {
    const { pickupDate, returnDate } = extractDates('from 15 to 19 October', REFERENCE_DATE);
    expect(pickupDate?.toISOString()).toContain('2026-10-15');
    expect(returnDate?.toISOString()).toContain('2026-10-19');
  });

  it('parses an ISO date', () => {
    const { pickupDate } = extractDates('pickup 2026-11-03', REFERENCE_DATE);
    expect(pickupDate?.toISOString()).toContain('2026-11-03');
  });

  it('parses a numeric DD/MM/YYYY date', () => {
    const { pickupDate } = extractDates('on 03/11/2026', REFERENCE_DATE);
    expect(pickupDate?.toISOString()).toContain('2026-11-03');
  });

  it('resolves "tomorrow" relative to the reference date', () => {
    const { pickupDate } = extractDates('I need the car tomorrow', REFERENCE_DATE);
    expect(pickupDate?.toISOString()).toContain('2026-09-02');
  });

  it('does not resolve a vague relative phrase into a concrete date', () => {
    const { pickupDate, ambiguousDateMentioned } = extractDates(
      'sometime next month would be great',
      REFERENCE_DATE,
    );
    expect(pickupDate).toBeUndefined();
    expect(ambiguousDateMentioned).toBe(true);
  });

  it('does not resolve a bare weekday into a concrete date', () => {
    const { pickupDate, ambiguousDateMentioned } = extractDates(
      'maybe Friday works',
      REFERENCE_DATE,
    );
    expect(pickupDate).toBeUndefined();
    expect(ambiguousDateMentioned).toBe(true);
  });

  it('returns no dates and no ambiguity flag for a message with none', () => {
    const result = extractDates('I need a car in Dubai', REFERENCE_DATE);
    expect(result.pickupDate).toBeUndefined();
    expect(result.returnDate).toBeUndefined();
    expect(result.ambiguousDateMentioned).toBe(false);
  });
});
