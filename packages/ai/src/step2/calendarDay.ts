/**
 * Compares two instants by calendar day (in a given IANA zone), not by raw
 * instant. Used for the PAST_DATE check: a pickup request for "today" must
 * not be flagged as past just because the request arrived after this
 * service's fixed default pickup hour (10:00 local) later in the same day.
 */
export function isBeforeCalendarDay(a: Date, b: Date, timeZone: string): boolean {
  const dayKey = (date: Date): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  return dayKey(a) < dayKey(b);
}
