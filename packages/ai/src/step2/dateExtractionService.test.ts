import { describe, expect, it } from 'vitest';
import { DateExtractionService } from './dateExtractionService.js';

const service = new DateExtractionService();
const REFERENCE_DATE = new Date('2026-09-15T09:00:00.000Z');
const TZ = 'Asia/Dubai';

function extract(text: string) {
  return service.extract(text, { referenceDate: REFERENCE_DATE, timezone: TZ });
}

describe('DateExtractionService', () => {
  it('resolves "15 Oct" to pickup only', () => {
    const result = extract('pickup on 15 Oct');
    expect(result.pickupDate?.toISOString()).toBe('2026-10-15T06:00:00.000Z');
    expect(result.returnDate).toBeNull();
    expect(result.ambiguities).toEqual([]);
  });

  it('resolves "15-19 Oct" as pickup and return', () => {
    const result = extract('from 15-19 Oct');
    expect(result.pickupDate?.toISOString()).toBe('2026-10-15T06:00:00.000Z');
    expect(result.returnDate?.toISOString()).toBe('2026-10-19T06:00:00.000Z');
  });

  it('resolves "tomorrow" relative to the reference date', () => {
    const result = extract('I need it tomorrow');
    expect(result.pickupDate?.toISOString()).toBe('2026-09-16T06:00:00.000Z');
  });

  it('resolves "next Friday" to a concrete future date', () => {
    // reference date 2026-09-15 is a Tuesday; next Friday = 2026-09-18
    const result = extract('pickup next Friday');
    expect(result.pickupDate?.toISOString()).toBe('2026-09-18T06:00:00.000Z');
  });

  it('flags an ambiguous numeric date (10/11/26) instead of guessing', () => {
    const result = extract('pickup on 10/11/26');
    expect(result.pickupDate).toBeNull();
    expect(result.ambiguities).toContainEqual(
      expect.objectContaining({ code: 'AMBIGUOUS_NUMERIC_DATE', raw: '10/11/26' }),
    );
  });

  it('resolves an unambiguous numeric date where only one reading is valid', () => {
    // 25 can only be a day (>12), so this is unambiguously DD/MM/YYYY = 25 Nov 2026
    const result = extract('pickup on 25/11/2026');
    expect(result.pickupDate?.toISOString()).toBe('2026-11-25T06:00:00.000Z');
    expect(result.ambiguities).toEqual([]);
  });

  it('does not flag ambiguity when both readings land on the same date', () => {
    const result = extract('pickup on 05/05/2026');
    expect(result.pickupDate?.toISOString()).toBe('2026-05-05T06:00:00.000Z');
    expect(result.ambiguities).toEqual([]);
  });

  it('treats an impossible named-month date (31 February) as invalid, never rounding it forward', () => {
    const result = extract('pickup on 31 February');
    expect(result.pickupDate).toBeNull();
    expect(result.impossibleDateMentions).toContain('31 February');
  });

  it('treats an impossible numeric date (32/13/2026) as invalid', () => {
    const result = extract('pickup on 32/13/2026');
    expect(result.pickupDate).toBeNull();
    expect(result.impossibleDateMentions.length).toBeGreaterThan(0);
  });

  it('resolves an explicit past date without hallucinating a different one (validation is a separate layer)', () => {
    const result = extract('pickup on 1 January 2020');
    expect(result.pickupDate?.toISOString()).toBe('2020-01-01T06:00:00.000Z');
  });

  it('flags a vague relative phrase as ambiguous', () => {
    const result = extract('sometime next month works');
    expect(result.pickupDate).toBeNull();
    expect(result.ambiguities.some((a) => a.code === 'VAGUE_RELATIVE_DATE')).toBe(true);
  });

  it('flags a bare weekday (no "next") as ambiguous', () => {
    const result = extract('maybe Friday works for me');
    expect(result.pickupDate).toBeNull();
    expect(result.ambiguities.some((a) => a.code === 'BARE_WEEKDAY')).toBe(true);
  });

  it('never fabricates a date when none is mentioned', () => {
    const result = extract('I want to rent a car in Dubai');
    expect(result.pickupDate).toBeNull();
    expect(result.returnDate).toBeNull();
    expect(result.ambiguities).toEqual([]);
  });

  it('converts local wall-clock time to the correct UTC instant for the given timezone', () => {
    const result = service.extract('pickup 2026-11-03', {
      referenceDate: REFERENCE_DATE,
      timezone: 'America/New_York',
    });
    // 10:00 local in New York (winter, UTC-5) = 15:00 UTC
    expect(result.pickupDate?.toISOString()).toBe('2026-11-03T15:00:00.000Z');
  });
});
