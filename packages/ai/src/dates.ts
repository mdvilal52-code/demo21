import { MONTHS, MONTH_NAME_PATTERN } from './shared/monthNames.js';

const AMBIGUOUS_DATE_PATTERNS: RegExp[] = [
  /\b(next week|next month|sometime|soon|later|in a few days|one of these days)\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
];

export interface DateMatch {
  index: number;
  date: Date;
}

function resolveYear(
  month: number,
  day: number,
  referenceDate: Date,
  explicitYear?: number,
): number {
  if (explicitYear) return explicitYear;
  const candidate = new Date(Date.UTC(referenceDate.getUTCFullYear(), month, day, 10, 0, 0));
  return candidate.getTime() < referenceDate.getTime()
    ? referenceDate.getUTCFullYear() + 1
    : referenceDate.getUTCFullYear();
}

function toIsoNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day, 10, 0, 0));
}

export interface ExtractDatesResult {
  pickupDate?: Date;
  returnDate?: Date;
  ambiguousDateMentioned: boolean;
}

export function extractDates(rawText: string, referenceDate: Date): ExtractDatesResult {
  let text = rawText;
  const matches: DateMatch[] = [];

  const rangeRe = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:to|-|–|until|through)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME_PATTERN}\\.?\\s*(\\d{4})?\\b`,
    'i',
  );
  const rangeMatch = rangeRe.exec(text);
  if (rangeMatch?.[1] && rangeMatch[2] && rangeMatch[3]) {
    const day1 = Number(rangeMatch[1]);
    const day2 = Number(rangeMatch[2]);
    const month = MONTHS[rangeMatch[3].toLowerCase()];
    const explicitYear = rangeMatch[4] ? Number(rangeMatch[4]) : undefined;
    if (month !== undefined) {
      const year = resolveYear(month, day1, referenceDate, explicitYear);
      matches.push({ index: rangeMatch.index, date: toIsoNoon(year, month, day1) });
      matches.push({ index: rangeMatch.index + 1, date: toIsoNoon(year, month, day2) });
      text = text.slice(0, rangeMatch.index) + text.slice(rangeMatch.index + rangeMatch[0].length);
    }
  }

  const dayMonthRe = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME_PATTERN}\\.?\\s*(\\d{4})?\\b`,
    'gi',
  );
  for (const match of text.matchAll(dayMonthRe)) {
    const day = Number(match[1]);
    const month = MONTHS[match[2]!.toLowerCase()];
    if (month === undefined || day < 1 || day > 31) continue;
    const explicitYear = match[3] ? Number(match[3]) : undefined;
    const year = resolveYear(month, day, referenceDate, explicitYear);
    matches.push({ index: match.index, date: toIsoNoon(year, month, day) });
  }

  const monthDayRe = new RegExp(
    `\\b${MONTH_NAME_PATTERN}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?\\b`,
    'gi',
  );
  for (const match of text.matchAll(monthDayRe)) {
    const month = MONTHS[match[1]!.toLowerCase()];
    const day = Number(match[2]);
    if (month === undefined || day < 1 || day > 31) continue;
    const explicitYear = match[3] ? Number(match[3]) : undefined;
    const year = resolveYear(month, day, referenceDate, explicitYear);
    matches.push({ index: match.index, date: toIsoNoon(year, month, day) });
  }

  const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  for (const match of text.matchAll(isoRe)) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    if (month < 0 || month > 11 || day < 1 || day > 31) continue;
    matches.push({ index: match.index, date: toIsoNoon(year, month, day) });
  }

  const numericRe = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g;
  for (const match of text.matchAll(numericRe)) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const year = Number(match[3]);
    if (month < 0 || month > 11 || day < 1 || day > 31) continue;
    matches.push({ index: match.index, date: toIsoNoon(year, month, day) });
  }

  if (/\btomorrow\b/i.test(text)) {
    const tomorrow = new Date(referenceDate);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    matches.push({
      index: text.toLowerCase().indexOf('tomorrow'),
      date: toIsoNoon(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate()),
    });
  } else if (/\btoday\b/i.test(text)) {
    matches.push({
      index: text.toLowerCase().indexOf('today'),
      date: toIsoNoon(
        referenceDate.getUTCFullYear(),
        referenceDate.getUTCMonth(),
        referenceDate.getUTCDate(),
      ),
    });
  }

  matches.sort((a, b) => a.index - b.index);
  const ambiguousDateMentioned = AMBIGUOUS_DATE_PATTERNS.some((pattern) => pattern.test(rawText));

  return {
    pickupDate: matches[0]?.date,
    returnDate:
      matches[1] && matches[1].date.getTime() !== matches[0]?.date.getTime()
        ? matches[1].date
        : undefined,
    ambiguousDateMentioned,
  };
}
