import { describe, expect, it } from 'vitest';
import { isBeforeCalendarDay } from './calendarDay.js';

describe('isBeforeCalendarDay', () => {
  it('is false for the same calendar day even at different times', () => {
    const morning = new Date('2026-09-15T02:00:00.000Z'); // 06:00 Dubai
    const evening = new Date('2026-09-15T18:00:00.000Z'); // 22:00 Dubai
    expect(isBeforeCalendarDay(morning, evening, 'Asia/Dubai')).toBe(false);
  });

  it('is true when a is on an earlier calendar day than b', () => {
    const yesterday = new Date('2026-09-13T20:00:00.000Z'); // 2026-09-14 00:00 Dubai
    const today = new Date('2026-09-15T02:00:00.000Z'); // 2026-09-15 06:00 Dubai
    expect(isBeforeCalendarDay(yesterday, today, 'Asia/Dubai')).toBe(true);
  });

  it('accounts for the timezone offset near a UTC day boundary', () => {
    // 23:30 UTC on the 14th is already 03:30 on the 15th in Dubai (UTC+4)
    const lateUtc = new Date('2026-09-14T23:30:00.000Z');
    const dubaiSameDay = new Date('2026-09-15T02:00:00.000Z');
    expect(isBeforeCalendarDay(lateUtc, dubaiSameDay, 'Asia/Dubai')).toBe(false);
  });
});
