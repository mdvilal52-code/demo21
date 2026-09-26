import {
  EligibilityIntakeField,
  LicenseType,
  type EligibilityIntake,
  type EligibilityIntakeFieldValue,
  type LicenseTypeValue,
} from '@ai-concierge/domain';
import { findCountryInText, lookupCountry, normalizeForCountryLookup } from './countries.js';

/**
 * Deterministic, zero-network extraction of Step 5's customer details from
 * what a customer typed. It is the always-available baseline: the Gemini
 * extractor (`geminiIntakeExtractor.ts`) only fills whatever this leaves
 * unresolved, and its output goes through the same validation. Every
 * extraction here is conservative — when a value is ambiguous (a `03/04/1990`
 * date, two nationalities in one sentence) it is *not* extracted and the
 * concierge asks again, because a wrong guess would feed a real eligibility
 * decision.
 */
export interface ExtractIntakeInput {
  /** The one customer message to read (never the whole transcript). */
  text: string;
  /** True once the concierge has already asked for these details in this conversation. */
  asked: boolean;
  /** Fields still needed — lets a bare "yes"/"no" bind to the only open yes/no question. */
  missing: readonly EligibilityIntakeFieldValue[];
  now: Date;
}

export interface IntakeExtraction {
  patch: Partial<EligibilityIntake>;
  /** A date-of-birth-looking date was present but could not be read unambiguously. */
  dateOfBirthAmbiguous: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const MONTH_NAMES = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

const MIN_DRIVER_AGE_YEARS = 16;
const MAX_PLAUSIBLE_AGE_YEARS = 100;

interface DateCandidate {
  iso: string | null;
  index: number;
  ambiguous: boolean;
}

function toIso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function collectDateCandidates(text: string): DateCandidate[] {
  const candidates: DateCandidate[] = [];
  const lowered = text.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');

  for (const match of lowered.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    candidates.push({
      iso: toIso(Number(match[1]), Number(match[2]), Number(match[3])),
      index: match.index ?? 0,
      ambiguous: false,
    });
  }

  for (const match of lowered.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g)) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = Number(match[3]);
    // Both parts <= 12 and different: could be DD/MM or MM/DD — never guess.
    const ambiguous = first <= 12 && second <= 12 && first !== second;
    let iso: string | null = null;
    if (!ambiguous) {
      // Exactly one reading is possible: a part > 12 can only be the day.
      iso = first > 12 ? toIso(year, second, first) : toIso(year, first, second);
    }
    candidates.push({ iso, index: match.index ?? 0, ambiguous });
  }

  const dayMonthYear = new RegExp(
    `\\b(\\d{1,2})\\s*(?:of\\s+)?(${MONTH_NAMES})[a-z]*[.,]?\\s*(\\d{4})\\b`,
    'g',
  );
  for (const match of lowered.matchAll(dayMonthYear)) {
    candidates.push({
      iso: toIso(Number(match[3]), MONTHS[match[2] as string] as number, Number(match[1])),
      index: match.index ?? 0,
      ambiguous: false,
    });
  }

  const monthDayYear = new RegExp(
    `\\b(${MONTH_NAMES})[a-z]*\\s+(\\d{1,2})[.,]?\\s*(\\d{4})\\b`,
    'g',
  );
  for (const match of lowered.matchAll(monthDayYear)) {
    candidates.push({
      iso: toIso(Number(match[3]), MONTHS[match[1] as string] as number, Number(match[2])),
      index: match.index ?? 0,
      ambiguous: false,
    });
  }

  return candidates;
}

const BIRTH_CUE = /(born|birth|d\.?o\.?b|birthday|janm)/;

export function extractDateOfBirth(
  text: string,
  asked: boolean,
  now: Date,
): { value: string | null; ambiguous: boolean } {
  const lowered = text.toLowerCase();
  const thisYear = now.getUTCFullYear();

  // A date of birth is in the past by at least MIN_DRIVER_AGE_YEARS: this alone
  // separates it from a pickup/return date typed in the same message.
  const plausible = collectDateCandidates(text).filter((candidate) => {
    if (candidate.ambiguous) return true;
    if (!candidate.iso) return false;
    const year = Number(candidate.iso.slice(0, 4));
    return year <= thisYear - MIN_DRIVER_AGE_YEARS && year >= thisYear - MAX_PLAUSIBLE_AGE_YEARS;
  });
  if (plausible.length === 0) return { value: null, ambiguous: false };

  const cueIndices = [...lowered.matchAll(new RegExp(BIRTH_CUE, 'g'))].map(
    (match) => match.index ?? 0,
  );
  const cued = plausible.filter((candidate) =>
    cueIndices.some((cue) => candidate.index >= cue && candidate.index - cue <= 60),
  );

  let chosen: DateCandidate | undefined;
  if (cued.length > 0) {
    chosen = cued[0];
  } else if (asked && plausible.length === 1) {
    // No cue word, but we just asked for it and there is exactly one plausible date.
    chosen = plausible[0];
  }
  if (!chosen) return { value: null, ambiguous: false };
  if (chosen.ambiguous || !chosen.iso) return { value: null, ambiguous: true };
  return { value: chosen.iso, ambiguous: false };
}

const LICENSE_WORD = String.raw`(?:driving\s+)?(?:licen[cs]e|permit)`;
const LICENSE_INVALID =
  /\b(expired|suspended|revoked|cancell?ed|invalid|not valid|no longer valid|lapsed)\b/;
const NO_LICENSE =
  /\b(no|don'?t have|do not have|dont have|without|never had)\s+(?:a\s+|any\s+|my\s+)?(?:valid\s+)?(?:driving\s+)?(?:licen[cs]e|permit)\b/;

function detectLicenseType(lowered: string): LicenseTypeValue | null {
  if (
    new RegExp(String.raw`\b(?:uae|u\.a\.e|emirates|emirati|dubai)\s+${LICENSE_WORD}`).test(
      lowered,
    ) ||
    new RegExp(
      String.raw`${LICENSE_WORD}\s+(?:from|issued in|of)\s+(?:the\s+)?(?:uae|emirates|dubai)`,
    ).test(lowered) ||
    /\b(?:resident|residence)\s+(?:driving\s+)?licen[cs]e\b/.test(lowered)
  ) {
    return LicenseType.UAE;
  }
  if (
    new RegExp(
      String.raw`\b(?:gcc|saudi|kuwaiti?|qatari?|bahraini?|omani?)\s+${LICENSE_WORD}`,
    ).test(lowered) ||
    new RegExp(
      String.raw`${LICENSE_WORD}\s+(?:from|issued in|of)\s+(?:the\s+)?(?:gcc|saudi|kuwait|qatar|bahrain|oman)`,
    ).test(lowered) ||
    /\bgcc\b/.test(lowered)
  ) {
    return LicenseType.GCC;
  }
  if (
    /\b(?:idp|international\s+driving\s+(?:permit|licen[cs]e)|international\s+(?:licen[cs]e|permit)|international\s+driver'?s?\s+(?:permit|licen[cs]e))\b/.test(
      lowered,
    )
  ) {
    return LicenseType.IDP;
  }
  if (
    /\b(?:foreign|home\s+country|my\s+country|own\s+country|overseas)\s+(?:driving\s+)?(?:licen[cs]e|permit)\b/.test(
      lowered,
    )
  ) {
    return LicenseType.FOREIGN;
  }
  // "Indian licence" / "licence from India": a national licence of a non-UAE/GCC country.
  const before = /\b([a-z]+(?:\s[a-z]+)?)\s+(?:driving\s+)?(?:licen[cs]e|permit)\b/.exec(
    lowered,
  )?.[1];
  const after =
    /\b(?:licen[cs]e|permit)\s+(?:from|issued in|of)\s+(?:the\s+)?([a-z]+(?:\s[a-z]+)?)/.exec(
      lowered,
    )?.[1];
  for (const phrase of [before, after]) {
    if (!phrase) continue;
    const words = phrase.split(' ');
    if (
      lookupCountry(phrase) !== null ||
      lookupCountry(words[words.length - 1] as string) !== null
    ) {
      return LicenseType.FOREIGN;
    }
  }
  return null;
}

const PASSPORT_NO =
  /(?:\b(?:no|don'?t have|do not have|dont have|without|lost|forgot|not carrying)\s+(?:a\s+|my\s+|any\s+|the\s+)?(?:valid\s+)?passport\b|\bpassport\s*[:-]?\s*(?:no|not available|nahi|nahin)\b)/;
const PASSPORT_YES =
  /(?:\b(?:have|hold|carry|got|has)\s+(?:a\s+|my\s+|the\s+)?(?:valid\s+)?passport\b|\bpassport\s*[:-]?\s*(?:yes|yep|available|ready|valid|with me|haan|ha)\b|\b(?:can|will)\s+(?:provide|show|share|send|submit)\s+(?:my\s+|the\s+)?passport\b|\bpassport\s+(?:is\s+)?(?:valid|available|ready|with me)\b)/;

const BARE_YES =
  /^\s*(?:yes|yeah|yep|yup|yea|sure|ok(?:ay)?|correct|right|haan|han|ha|ji|ji haan|i do|i have|of course|absolutely|definitely)\b/;
const BARE_NO = /^\s*(?:no|nope|nah|nahi|nahin|not really|i don'?t|i do not|i haven'?t)\b/;

const NATIONALITY_CUE_A =
  /\b(?:nationality|citizenship|citizen of|national of|passport holder|holding an?)\s*(?:is|:|-|of)?\s*(?:an?\s+|the\s+)?([a-z]+(?: [a-z]+)?)/;
const NATIONALITY_CUE_B =
  /\b(?:i am|i'?m|im|we are|we'?re|am)\s+(?:an?\s+|a\s+citizen of\s+|from\s+)?(?:the\s+)?([a-z]+(?: [a-z]+)?)/;
const NATIONALITY_CUE_C = /\b([a-z]+(?: [a-z]+)?)\s+(?:national|citizen|passport)\b/;

function extractNationality(text: string, asked: boolean): string | null {
  // Licence phrases ("UAE licence", "Indian driving permit") name a country
  // without being a nationality statement — strip them before looking.
  const stripped = normalizeForCountryLookup(
    text.replace(/\b[\w']+(?:\s[\w']+)?\s+(?:driving\s+)?(?:licen[cs]e|permit)\b/gi, ' '),
  );

  for (const cue of [NATIONALITY_CUE_A, NATIONALITY_CUE_C, NATIONALITY_CUE_B]) {
    const match = cue.exec(stripped);
    if (match?.[1]) {
      const words = match[1].split(' ');
      const found = lookupCountry(match[1]) ?? lookupCountry(words[0] as string);
      if (found) return found;
    }
  }

  // No cue: a short reply to our own question ("Indian", "I'm 12 May 1990, Indian").
  const wordCount = stripped.split(' ').filter(Boolean).length;
  if (asked && wordCount <= 18) return findCountryInText(stripped);
  return null;
}

/**
 * Removes the quoted earlier conversation an email client appends to a reply
 * ("> ..." lines, "On <date> <name> wrote:", "-----Original Message-----").
 * Without this, a customer replying by email would have OUR previous message —
 * including its "for example 12 May 1990" hint — read back as their own answer.
 * Falls back to the original text if stripping would leave nothing.
 */
export function stripQuotedReply(text: string): string {
  const cutAtHeader = text.replace(
    /(?:^|\n)[ \t]*(?:On [\s\S]{5,300}?wrote:|-{2,}\s*Original Message\s*-{2,})[\s\S]*$/i,
    '',
  );
  const withoutQuotedLines = cutAtHeader
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .trim();
  return withoutQuotedLines.length > 0 ? withoutQuotedLines : text;
}

export function extractEligibilityIntake(input: ExtractIntakeInput): IntakeExtraction {
  const lowered = input.text.toLowerCase();
  const patch: Partial<EligibilityIntake> = {};

  const dob = extractDateOfBirth(input.text, input.asked, input.now);
  if (dob.value) patch.dateOfBirth = dob.value;

  const nationality = extractNationality(input.text, input.asked);
  if (nationality) patch.nationality = nationality;

  const licenseType = detectLicenseType(lowered);
  if (NO_LICENSE.test(lowered)) {
    patch.licenseType = licenseType ?? LicenseType.FOREIGN;
    patch.hasValidLicense = false;
  } else if (licenseType) {
    patch.licenseType = licenseType;
    patch.hasValidLicense = !LICENSE_INVALID.test(lowered);
  } else if (LICENSE_INVALID.test(lowered) && /licen[cs]e|permit/.test(lowered)) {
    patch.hasValidLicense = false;
  }

  if (PASSPORT_NO.test(lowered)) patch.passportProvided = false;
  else if (PASSPORT_YES.test(lowered)) patch.passportProvided = true;

  // A bare yes/no answers the single yes/no question still open — never a guess between two.
  const openYesNo = input.missing.filter(
    (field) =>
      (field === EligibilityIntakeField.PASSPORT && patch.passportProvided === undefined) ||
      (field === EligibilityIntakeField.LICENSE_VALID && patch.hasValidLicense === undefined),
  );
  const openFieldCount = input.missing.filter(
    (field) =>
      !(field === EligibilityIntakeField.DATE_OF_BIRTH && patch.dateOfBirth !== undefined) &&
      !(field === EligibilityIntakeField.NATIONALITY && patch.nationality !== undefined) &&
      !(field === EligibilityIntakeField.LICENSE_TYPE && patch.licenseType !== undefined),
  ).length;
  const shortReply = input.text.trim().split(/\s+/).length <= 6;
  if (input.asked && shortReply && openYesNo.length === 1 && openFieldCount === 1) {
    const answer = BARE_YES.test(lowered) ? true : BARE_NO.test(lowered) ? false : null;
    if (answer !== null) {
      if (openYesNo[0] === EligibilityIntakeField.PASSPORT) patch.passportProvided = answer;
      else patch.hasValidLicense = answer;
    }
  }

  return { patch, dateOfBirthAmbiguous: dob.ambiguous };
}
