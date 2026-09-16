/**
 * Converts a wall-clock date/time in a given IANA timezone to the correct
 * UTC instant, using only built-in `Intl` (no date-tz dependency). Correct
 * across DST transitions because it asks the ICU timezone database (via
 * `Intl.DateTimeFormat`) what a UTC guess actually displays as in that zone,
 * then corrects for the difference — the standard "double conversion"
 * technique. Asia/Dubai itself has no DST (fixed UTC+4 year-round), but this
 * works unmodified for any zone that does, which is what "architecture must
 * support future cities/countries" requires.
 */
export function zonedTimeToUtc(
  year: number,
  month0: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month0, day, hour, minute, second);

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(new Date(utcGuess));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const displayedAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second'),
  );

  const offsetMs = displayedAsUtc - utcGuess;
  return new Date(utcGuess - offsetMs);
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
