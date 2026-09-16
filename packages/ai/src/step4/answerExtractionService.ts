import {
  MissingInfoFieldKey,
  type MissingInfoFieldKeyValue,
  type MissingInfoValue,
} from '@ai-concierge/domain';
import { DRIVER_REQUIRED_KEYWORDS, SELF_DRIVE_KEYWORDS } from '../lexicon.js';

export interface ExtractedAnswerCandidate {
  field: MissingInfoFieldKeyValue;
  value: MissingInfoValue;
}

// Case-insensitive — flight codes are commonly typed lowercase; extractFlightNumbers uppercases the result.
const FLIGHT_NUMBER_RE = /\b([A-Za-z]{2})[ -]?(\d{2,4})\b/g;
// 12h form requires an explicit am/pm so a bare number ("5", "10") is never mistaken for a time.
const TIME_12H_RE = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/gi;
// 24h form requires the strict HH:MM shape (leading zero / 13-23), never a bare number either.
const TIME_24H_RE = /\b([01]\d|2[0-3]):([0-5]\d)\b/g;
// Bounded to realistic email part lengths (RFC 5321: local <=64, domain <=255) — never unbounded.
const EMAIL_RE = /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,190}\.[a-zA-Z]{2,24}/g;
// Bounded to a realistic phone number length (international numbers top out around 15 digits)
// so a pathological run of digits can never produce a candidate longer than the field allows.
const PHONE_RE = /(?:\+?\d[\d\s-]{7,18}\d)/g;
/** Matches contactDetailsValueSchema's max — belt-and-suspenders even with the bounded regexes above. */
const CONTACT_DETAILS_MAX_LENGTH = 200;
// An explicit drop-off/delivery/address phrase anchor — everything after it is the address text,
// so a multi-intent reply ("...drop off at Burj Al Arab") never needs the whole message guessed at.
const DROPOFF_ADDRESS_ANCHOR_RE =
  /\b(?:drop(?:\s*-?\s*off)?(?:\s+(?:at|to|in))?|deliver(?:y)?(?:\s+(?:at|to))?|(?:the\s+)?address\s*(?:is|:)?|hotel\s*(?:is|:)?)\s+(.+)/i;

const FREE_TEXT_MAX_LENGTH: Record<string, number> = {
  [MissingInfoFieldKey.DROPOFF_ADDRESS]: 300,
  [MissingInfoFieldKey.SPECIAL_REQUESTS]: 500,
};

function to24Hour(hour: number, minute: number, meridiem?: 'am' | 'pm'): string {
  let normalizedHour = hour;
  if (meridiem === 'pm' && normalizedHour !== 12) normalizedHour += 12;
  if (meridiem === 'am' && normalizedHour === 12) normalizedHour = 0;
  return `${String(normalizedHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * AI-proposes layer for Step 4 — pure, zero I/O, regex/keyword based (same
 * discipline as Phase 1's RuleBasedIntentEngine): every candidate returned
 * here has real textual evidence in the message; nothing is ever guessed.
 * `MissingFieldDetector`/`ConversationState` (deterministic) decide what to
 * do with these candidates.
 */
export class AnswerExtractionService {
  /** Pattern-detectable fields — scanned unconditionally on every turn. */
  extractStructuredCandidates(sanitizedText: string): ExtractedAnswerCandidate[] {
    const candidates: ExtractedAnswerCandidate[] = [];

    for (const flightNumber of this.extractFlightNumbers(sanitizedText)) {
      candidates.push({ field: MissingInfoFieldKey.FLIGHT_NUMBER, value: flightNumber });
    }
    for (const time of this.extractPickupTimes(sanitizedText)) {
      candidates.push({ field: MissingInfoFieldKey.PICKUP_TIME, value: time });
    }
    for (const driverRequired of this.extractDriverRequirement(sanitizedText)) {
      candidates.push({ field: MissingInfoFieldKey.DRIVER_REQUIREMENT, value: driverRequired });
    }
    for (const contact of this.extractContactDetails(sanitizedText)) {
      candidates.push({ field: MissingInfoFieldKey.CONTACT_DETAILS, value: contact });
    }

    return candidates;
  }

  /**
   * Free text (address / special requests) can't be pattern-matched safely,
   * so it is only ever captured as the answer to a field the caller has
   * confirmed is the single outstanding question this message is replying
   * to — never scanned for opportunistically like the structured fields.
   *
   * A dropoff address gets one extra safeguard: an explicit "drop off
   * at/deliver to/address is" anchor phrase is tried first, so a reply that
   * mixes an address in with other information ("...drop off at Burj Al
   * Arab") captures just the address, not the whole message. Without that
   * anchor, the whole message is only used when `allowUnanchoredCapture` is
   * true — the caller sets this to false whenever the message already
   * yielded *other* structured answers, since a message clearly about those
   * fields is not a plausible plain-text address/request and should never
   * be guessed at.
   */
  extractFreeTextAnswer(
    field: typeof MissingInfoFieldKey.DROPOFF_ADDRESS | typeof MissingInfoFieldKey.SPECIAL_REQUESTS,
    sanitizedText: string,
    options: { allowUnanchoredCapture: boolean },
  ): ExtractedAnswerCandidate | null {
    if (field === MissingInfoFieldKey.DROPOFF_ADDRESS) {
      const anchored = DROPOFF_ADDRESS_ANCHOR_RE.exec(sanitizedText);
      if (anchored?.[1]) {
        return this.buildFreeTextCandidate(field, this.trimTrailingOtherFieldContent(anchored[1]));
      }
    }

    return options.allowUnanchoredCapture
      ? this.buildFreeTextCandidate(field, sanitizedText)
      : null;
  }

  private buildFreeTextCandidate(
    field: typeof MissingInfoFieldKey.DROPOFF_ADDRESS | typeof MissingInfoFieldKey.SPECIAL_REQUESTS,
    rawValue: string,
  ): ExtractedAnswerCandidate | null {
    // The internal "[REMOVED]" placeholder must never itself become part of a
    // stored answer — strip it (and any resulting double-space) before the
    // length check and before this ever becomes the value that leaves here.
    const cleanedValue = rawValue
      .replace(/\[REMOVED\]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleanedValue.length < 3) {
      return null;
    }
    const maxLength = FREE_TEXT_MAX_LENGTH[field] ?? 300;
    return { field, value: cleanedValue.slice(0, maxLength) };
  }

  /**
   * The anchor capture (`(.+)`) is deliberately greedy so a real address can
   * contain commas/numbers, but that means it also swallows anything the
   * customer adds after it in the same breath ("...Burj Al Arab, my number
   * is 0501234567"). Cut the captured text off at the first sign of a new
   * sentence or of content that belongs to a *different* field (email,
   * phone, flight number) — and back up to the preceding comma if there is
   * one, so the trailing connective clause doesn't linger either.
   */
  private trimTrailingOtherFieldContent(value: string): string {
    const boundaryIndexes = [/[.!?\n]/, EMAIL_RE, PHONE_RE, FLIGHT_NUMBER_RE]
      .map(
        (pattern) => new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(value)?.index,
      )
      .filter((index): index is number => index !== undefined);
    if (boundaryIndexes.length === 0) {
      return value.trim();
    }

    const cutoff = Math.min(...boundaryIndexes);
    const lastCommaBeforeCutoff = value.lastIndexOf(',', cutoff);
    return value.slice(0, lastCommaBeforeCutoff >= 0 ? lastCommaBeforeCutoff : cutoff).trim();
  }

  private extractFlightNumbers(text: string): string[] {
    const matches = [...text.matchAll(FLIGHT_NUMBER_RE)];
    const values = matches.map((match) => `${match[1]}${match[2]}`.toUpperCase());
    return [...new Set(values)];
  }

  private extractPickupTimes(text: string): string[] {
    const values = new Set<string>();
    for (const match of text.matchAll(TIME_12H_RE)) {
      const hour = Number(match[1]);
      const minute = match[2] ? Number(match[2]) : 0;
      const meridiem = match[3]!.toLowerCase() as 'am' | 'pm';
      values.add(to24Hour(hour, minute, meridiem));
    }
    for (const match of text.matchAll(TIME_24H_RE)) {
      values.add(`${match[1]}:${match[2]}`);
    }
    return [...values];
  }

  /**
   * A keyword match immediately preceded by a negation ("I don't need a
   * driver", "not without a driver") means the opposite of what the bare
   * keyword says — checked and flipped here rather than left for a
   * downstream layer to ever mis-record what the customer actually said.
   */
  private extractDriverRequirement(text: string): boolean[] {
    const lowerText = text.toLowerCase();
    const values = new Set<boolean>();

    for (const keyword of DRIVER_REQUIRED_KEYWORDS) {
      const index = lowerText.indexOf(keyword);
      if (index === -1) continue;
      values.add(!this.isNegated(lowerText, index));
    }
    for (const keyword of SELF_DRIVE_KEYWORDS) {
      const index = lowerText.indexOf(keyword);
      if (index === -1) continue;
      values.add(this.isNegated(lowerText, index));
    }

    return [...values];
  }

  private isNegated(lowerText: string, matchIndex: number): boolean {
    const precedingWindow = lowerText.slice(Math.max(0, matchIndex - 30), matchIndex);
    return /\b(?:don't|do not|doesn't|does not|won't|will not|never|not)\b(?:\s+\w+){0,2}\s*$/.test(
      precedingWindow,
    );
  }

  /**
   * At most one candidate, even if the message contains both an email and a
   * phone number — offering two *reachable* channels is not a contradiction
   * (unlike two different flight numbers or opposite driver-requirement
   * signals), and the field only ever stores one value; email is preferred
   * as the more precise/durable channel when both are present.
   */
  private extractContactDetails(text: string): string[] {
    const email = text.match(EMAIL_RE)?.[0];
    const phone = text.match(PHONE_RE)?.[0]?.trim();
    const value = email ?? phone;
    return value ? [value.slice(0, CONTACT_DETAILS_MAX_LENGTH)] : [];
  }
}
