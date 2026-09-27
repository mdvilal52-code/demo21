export function formatFieldName(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase());
}

// Every word in a SCREAMING_SNAKE_CASE enum value is already upper-case, so
// casing alone can't tell "AI"/"SMS" (keep as an acronym) apart from
// "TO"/"OF" (an ordinary short word) — hence the explicit list.
const ACRONYMS = new Set(['AI', 'SMS', 'SLA', 'ID', 'VIP', 'UAE', 'GCC', 'IDP', 'CRM']);

/** `AI_UNABLE_TO_PROCEED` -> `AI unable to proceed` — for domain enum values (JourneyState, EscalationReason, ...) shown as UI copy. */
export function formatEnumLabel(value: string): string {
  const words = value.split('_').filter(Boolean);
  return words
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word;
      return index === 0
        ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        : word.toLowerCase();
    })
    .join(' ');
}

/**
 * `{ minorUnits: 1470000, currency: 'AED' }` -> `AED 14,700`; `1475250` -> `AED 14,752.50`.
 * Amounts are integer minor units, never floats; cents show as two digits or not at all.
 */
export function formatMoney(minorUnits: number, currency: string): string {
  const major = minorUnits / 100;
  const digits = minorUnits % 100 === 0 ? 0 : 2;
  return `${currency} ${major.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Every screen shows Dubai time: the server renders in UTC, and the business runs on Dubai's clock. */
export const DISPLAY_TIME_ZONE = 'Asia/Dubai';

/**
 * `2026-09-26T09:05:00Z` -> `26 Sep 2026, 13:05`. Built from numeric parts, never the locale's month
 * abbreviation (ICU versions disagree: "Sep" vs "Sept"), so the text is identical everywhere.
 */
export function formatDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const month = MONTHS[Number(get('month')) - 1] ?? get('month');
  return `${Number(get('day'))} ${month} ${get('year')}, ${get('hour')}:${get('minute')}`;
}

/** `2026-10-15T06:00:00Z` -> `15 Oct 2026` (Dubai date). */
export function formatDate(iso: string): string {
  return formatDateTime(iso).split(',')[0] ?? iso;
}
