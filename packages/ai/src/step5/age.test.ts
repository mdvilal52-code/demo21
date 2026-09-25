import { describe, expect, it } from 'vitest';
import { calculateAgeAt } from './age.js';

describe('calculateAgeAt', () => {
  it('counts a full year once the birthday has passed this year', () => {
    expect(calculateAgeAt('2000-06-15', new Date('2026-06-16T00:00:00.000Z'))).toBe(26);
  });

  it('counts the birthday itself as already turned', () => {
    expect(calculateAgeAt('2000-06-15', new Date('2026-06-15T00:00:00.000Z'))).toBe(26);
  });

  it('does not count the year yet the day before the birthday', () => {
    expect(calculateAgeAt('2000-06-15', new Date('2026-06-14T00:00:00.000Z'))).toBe(25);
  });

  it('handles a leap-year (Feb 29) date of birth', () => {
    expect(calculateAgeAt('2000-02-29', new Date('2026-03-01T00:00:00.000Z'))).toBe(26);
    expect(calculateAgeAt('2000-02-29', new Date('2026-02-28T00:00:00.000Z'))).toBe(25);
  });
});
