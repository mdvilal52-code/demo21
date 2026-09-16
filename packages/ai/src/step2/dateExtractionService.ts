import type { Ambiguity } from '@ai-concierge/domain';
import { isValidCalendarDate } from './calendar.js';
import { MONTHS, MONTH_NAME_PATTERN } from '../shared/monthNames.js';
import { zonedTimeToUtc } from './timezone.js';

const DEFAULT_LOCAL_HOUR = 10;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const VAGUE_RELATIVE_RE =
  /\b(next week|next month|sometime|soon|later|in a few days|one of these days)\b/i;
const BARE_WEEKDAY_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const NEXT_WEEKDAY_RE = /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

interface LocalDateTime {
  year: number;
  month0: number;
  day: number;
  hour: number;
  minute: number;
}

interface DateToken {
  index: number;
  local: LocalDateTime | null; // null when found-but-not-resolvable (impossible / ambiguous)
  ambiguity?: Ambiguity;
  impossible?: boolean;
  raw: string;
}

function resolveYear(
  month0: number,
  day: number,
  referenceDate: Date,
  explicitYear?: number,
): number {
  if (explicitYear !== undefined) return explicitYear;
  const candidateUtc = Date.UTC(referenceDate.getUTCFullYear(), month0, day, DEFAULT_LOCAL_HOUR);
  return candidateUtc < referenceDate.getTime()
    ? referenceDate.getUTCFullYear() + 1
    : referenceDate.getUTCFullYear();
}

function normalizeTwoDigitYear(yy: number): number {
  return yy <= 79 ? 2000 + yy : 1900 + yy;
}

export interface DateExtractionOutcome {
  pickupDate: Date | null;
  returnDate: Date | null;
  ambiguities: Ambiguity[];
  /** Calendar-invalid mentions (e.g. "31 February") — never silently corrected. */
  impossibleDateMentions: string[];
}

export interface DateExtractionOptions {
  referenceDate: Date;
  timezone: string;
}

/**
 * AI-side proposal step for pickup/return dates. Deliberately conservative:
 * a numeric date like "10/11/26" that could be read as either DD/MM or
 * MM/DD is never guessed — it's reported as an ambiguity instead, and
 * `TemporalValidationService` is what a caller must consult before trusting
 * the result.
 */
export class DateExtractionService {
  extract(rawText: string, options: DateExtractionOptions): DateExtractionOutcome {
    const ambiguities: Ambiguity[] = [];
    const impossibleDateMentions: string[] = [];
    const tokens: DateToken[] = [];
    let workingText = rawText;

    const range = this.matchDayRange(workingText, options.referenceDate);
    if (range) {
      tokens.push(...range.tokens);
      workingText = range.remainingText;
    }

    tokens.push(...this.matchNamedMonthDates(workingText, options.referenceDate));
    tokens.push(...this.matchIsoDates(workingText));
    tokens.push(...this.matchNumericDates(workingText));
    tokens.push(...this.matchRelativeKeywords(workingText, options.referenceDate));
    tokens.push(...this.matchNextWeekday(workingText, options.referenceDate));

    for (const token of tokens) {
      if (token.impossible) impossibleDateMentions.push(token.raw);
      if (token.ambiguity) ambiguities.push(token.ambiguity);
    }

    if (VAGUE_RELATIVE_RE.test(rawText)) {
      ambiguities.push({
        field: 'pickupDate',
        code: 'VAGUE_RELATIVE_DATE',
        message: 'A vague relative date phrase was used and cannot be resolved to a specific day',
        raw: VAGUE_RELATIVE_RE.exec(rawText)?.[0],
      });
    }
    if (BARE_WEEKDAY_RE.test(rawText) && !NEXT_WEEKDAY_RE.test(rawText)) {
      ambiguities.push({
        field: 'pickupDate',
        code: 'BARE_WEEKDAY',
        message:
          'A weekday was mentioned without "next"/"this" and could refer to more than one date',
        raw: BARE_WEEKDAY_RE.exec(rawText)?.[0],
      });
    }

    const resolved = tokens
      .filter((token): token is DateToken & { local: LocalDateTime } => token.local !== null)
      .sort((a, b) => a.index - b.index)
      .map((token) =>
        zonedTimeToUtc(
          token.local.year,
          token.local.month0,
          token.local.day,
          token.local.hour,
          token.local.minute,
          0,
          options.timezone,
        ),
      );

    const pickupDate = resolved[0] ?? null;
    const returnDate =
      resolved[1] && resolved[1].getTime() !== pickupDate?.getTime() ? resolved[1] : null;

    return { pickupDate, returnDate, ambiguities, impossibleDateMentions };
  }

  private matchDayRange(
    text: string,
    referenceDate: Date,
  ): { tokens: DateToken[]; remainingText: string } | null {
    const rangeRe = new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:to|-|–|until|through)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME_PATTERN}\\.?\\s*(\\d{4})?\\b`,
      'i',
    );
    const match = rangeRe.exec(text);
    if (!match?.[1] || !match[2] || !match[3]) return null;

    const day1 = Number(match[1]);
    const day2 = Number(match[2]);
    const month0 = MONTHS[match[3].toLowerCase()];
    if (month0 === undefined) return null;
    const explicitYear = match[4] ? Number(match[4]) : undefined;

    const tokens: DateToken[] = [];
    for (const [offset, day] of [[0, day1] as const, [1, day2] as const]) {
      const year = resolveYear(month0, day, referenceDate, explicitYear);
      if (!isValidCalendarDate(year, month0, day)) {
        tokens.push({ index: match.index + offset, local: null, impossible: true, raw: match[0] });
        continue;
      }
      tokens.push({
        index: match.index + offset,
        local: { year, month0, day, hour: DEFAULT_LOCAL_HOUR, minute: 0 },
        raw: match[0],
      });
    }

    const remainingText = text.slice(0, match.index) + text.slice(match.index + match[0].length);
    return { tokens, remainingText };
  }

  private matchNamedMonthDates(text: string, referenceDate: Date): DateToken[] {
    const tokens: DateToken[] = [];

    const dayMonthRe = new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME_PATTERN}\\.?\\s*(\\d{4})?\\b`,
      'gi',
    );
    for (const match of text.matchAll(dayMonthRe)) {
      const day = Number(match[1]);
      const month0 = MONTHS[match[2]!.toLowerCase()];
      if (month0 === undefined) continue;
      tokens.push(
        this.buildNamedMonthToken(match.index, match[0], day, month0, match[3], referenceDate),
      );
    }

    const monthDayRe = new RegExp(
      `\\b${MONTH_NAME_PATTERN}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?\\b`,
      'gi',
    );
    for (const match of text.matchAll(monthDayRe)) {
      const month0 = MONTHS[match[1]!.toLowerCase()];
      const day = Number(match[2]);
      if (month0 === undefined) continue;
      tokens.push(
        this.buildNamedMonthToken(match.index, match[0], day, month0, match[3], referenceDate),
      );
    }

    return tokens;
  }

  private buildNamedMonthToken(
    index: number,
    raw: string,
    day: number,
    month0: number,
    explicitYearRaw: string | undefined,
    referenceDate: Date,
  ): DateToken {
    const explicitYear = explicitYearRaw ? Number(explicitYearRaw) : undefined;
    const year = resolveYear(month0, day, referenceDate, explicitYear);
    if (!isValidCalendarDate(year, month0, day)) {
      return { index, local: null, impossible: true, raw };
    }
    return { index, local: { year, month0, day, hour: DEFAULT_LOCAL_HOUR, minute: 0 }, raw };
  }

  private matchIsoDates(text: string): DateToken[] {
    const tokens: DateToken[] = [];
    const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    for (const match of text.matchAll(isoRe)) {
      const year = Number(match[1]);
      const month0 = Number(match[2]) - 1;
      const day = Number(match[3]);
      if (!isValidCalendarDate(year, month0, day)) {
        tokens.push({ index: match.index, local: null, impossible: true, raw: match[0] });
        continue;
      }
      tokens.push({
        index: match.index,
        local: { year, month0, day, hour: DEFAULT_LOCAL_HOUR, minute: 0 },
        raw: match[0],
      });
    }
    return tokens;
  }

  private matchNumericDates(text: string): DateToken[] {
    const tokens: DateToken[] = [];
    const numericRe = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g;
    for (const match of text.matchAll(numericRe)) {
      const a = Number(match[1]);
      const b = Number(match[2]);
      const yearRaw = match[3]!;
      const year = yearRaw.length <= 2 ? normalizeTwoDigitYear(Number(yearRaw)) : Number(yearRaw);

      const asDayMonth = a >= 1 && a <= 31 && b >= 1 && b <= 12 ? { day: a, month0: b - 1 } : null;
      const asMonthDay = a >= 1 && a <= 12 && b >= 1 && b <= 31 ? { day: b, month0: a - 1 } : null;

      const validDayMonth =
        asDayMonth && isValidCalendarDate(year, asDayMonth.month0, asDayMonth.day);
      const validMonthDay =
        asMonthDay && isValidCalendarDate(year, asMonthDay.month0, asMonthDay.day);

      if (!validDayMonth && !validMonthDay) {
        tokens.push({ index: match.index, local: null, impossible: true, raw: match[0] });
        continue;
      }

      const sameResult =
        validDayMonth &&
        validMonthDay &&
        asDayMonth!.month0 === asMonthDay!.month0 &&
        asDayMonth!.day === asMonthDay!.day;

      if (validDayMonth && validMonthDay && !sameResult) {
        tokens.push({
          index: match.index,
          local: null,
          raw: match[0],
          ambiguity: {
            field: 'pickupDate',
            code: 'AMBIGUOUS_NUMERIC_DATE',
            message: `"${match[0]}" could be day/month or month/day and was not guessed`,
            raw: match[0],
          },
        });
        continue;
      }

      const resolved = (validDayMonth ? asDayMonth : asMonthDay)!;
      tokens.push({
        index: match.index,
        local: {
          year,
          month0: resolved.month0,
          day: resolved.day,
          hour: DEFAULT_LOCAL_HOUR,
          minute: 0,
        },
        raw: match[0],
      });
    }
    return tokens;
  }

  private matchRelativeKeywords(text: string, referenceDate: Date): DateToken[] {
    const tokens: DateToken[] = [];
    const tomorrowMatch = /\btomorrow\b/i.exec(text);
    if (tomorrowMatch) {
      const tomorrow = new Date(referenceDate);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tokens.push({
        index: tomorrowMatch.index,
        local: {
          year: tomorrow.getUTCFullYear(),
          month0: tomorrow.getUTCMonth(),
          day: tomorrow.getUTCDate(),
          hour: DEFAULT_LOCAL_HOUR,
          minute: 0,
        },
        raw: tomorrowMatch[0],
      });
      return tokens;
    }
    const todayMatch = /\btoday\b/i.exec(text);
    if (todayMatch) {
      tokens.push({
        index: todayMatch.index,
        local: {
          year: referenceDate.getUTCFullYear(),
          month0: referenceDate.getUTCMonth(),
          day: referenceDate.getUTCDate(),
          hour: DEFAULT_LOCAL_HOUR,
          minute: 0,
        },
        raw: todayMatch[0],
      });
    }
    return tokens;
  }

  private matchNextWeekday(text: string, referenceDate: Date): DateToken[] {
    const match = NEXT_WEEKDAY_RE.exec(text);
    if (!match?.[1]) return [];

    const targetWeekday = WEEKDAYS.indexOf(match[1].toLowerCase());
    const cursor = new Date(referenceDate);
    for (let i = 0; i < 8; i += 1) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (cursor.getUTCDay() === targetWeekday) break;
    }

    return [
      {
        index: match.index,
        local: {
          year: cursor.getUTCFullYear(),
          month0: cursor.getUTCMonth(),
          day: cursor.getUTCDate(),
          hour: DEFAULT_LOCAL_HOUR,
          minute: 0,
        },
        raw: match[0],
      },
    ];
  }
}
