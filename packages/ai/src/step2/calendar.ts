/**
 * JS `Date` silently rolls over an invalid day (Date.UTC(2026, 1, 30) becomes
 * March 2nd instead of failing) — this round-trips the construction and
 * rejects anything that didn't land on the intended day, so "31 February"
 * or "32/13/2026" are caught instead of quietly corrected.
 */
export function isValidCalendarDate(year: number, month0: number, day: number): boolean {
  if (month0 < 0 || month0 > 11 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month0, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month0 && date.getUTCDate() === day
  );
}
