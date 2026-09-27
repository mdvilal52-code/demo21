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

// Horizontal whitespace only ([ \t], never \s) throughout this function's
// phrase-matching: a customer answering several questions on separate lines
// ("Nationality: UAE\nDriving licence: ...") must never have one line's
// answer read as if it modified the *next* line's licence label — \s would
// match the newline between them and produce a licence type from a field
// that was never about licences at all.
const LICENSE_WORD = String.raw`(?:driving[ \t]+)?(?:licen[cs]e|permit)`;
const LICENSE_INVALID =
  /\b(expired|suspended|revoked|cancell?ed|invalid|not valid|no longer valid|lapsed)\b/;
const NO_LICENSE =
  /\b(no|don'?t have|do not have|dont have|without|never had)[ \t]+(?:a[ \t]+|any[ \t]+|my[ \t]+)?(?:valid[ \t]+)?(?:driving[ \t]+)?(?:licen[cs]e|permit)\b/;

/**
 * Every "<word(s)> licence/permit" or "licence/permit from <word(s)>" match
 * in `lowered`, in order — not just the first: a redundant label like
 * "Driving licence:" trivially matches the same shape as a genuine value
 * ("Indian driving licence") without naming a country, and must not shadow
 * a later, genuine match. Built from the shared `LICENSE_WORD` grammar so
 * this and `extractNationality`'s licence-phrase stripper (which reuses
 * `LICENSE_PHRASE_BEFORE_RE` directly) can never drift out of sync on what
 * counts as a licence phrase.
 */
const LICENSE_PHRASE_BEFORE_RE = new RegExp(
  String.raw`\b([a-z]+(?:[ \t][a-z]+)?)[ \t]+${LICENSE_WORD}\b`,
  'g',
);
const LICENSE_PHRASE_AFTER_RE = new RegExp(
  String.raw`\b${LICENSE_WORD}[ \t]+(?:from|issued in|of)[ \t]+(?:the[ \t]+)?([a-z]+(?:[ \t][a-z]+)?)`,
  'g',
);

function licensePhraseCandidates(lowered: string): string[] {
  const before = [...lowered.matchAll(LICENSE_PHRASE_BEFORE_RE)].map((match) => match[1]);
  const after = [...lowered.matchAll(LICENSE_PHRASE_AFTER_RE)].map((match) => match[1]);
  return [...before, ...after].filter((phrase): phrase is string => Boolean(phrase));
}

/**
 * True when `phrase` names a country, checking every word individually and
 * not just the last: which word is the country name shifts with the
 * sentence around it ("an Indian driving licence" leaves "an indian" as the
 * captured phrase — last word "indian" — but "Indian driving licence" with
 * no leading article leaves "indian driving" — last word "driving").
 */
function phraseNamesACountry(phrase: string): boolean {
  if (lookupCountry(phrase) !== null) return true;
  return phrase.split(/[ \t]+/).some((word) => lookupCountry(word) !== null);
}

function detectLicenseType(lowered: string): LicenseTypeValue | null {
  if (
    new RegExp(String.raw`\b(?:uae|u\.a\.e|emirates|emirati|dubai)[ \t]+${LICENSE_WORD}`).test(
      lowered,
    ) ||
    new RegExp(
      String.raw`${LICENSE_WORD}[ \t]+(?:from|issued in|of)[ \t]+(?:the[ \t]+)?(?:uae|emirates|dubai)`,
    ).test(lowered) ||
    /\b(?:resident|residence)[ \t]+(?:driving[ \t]+)?licen[cs]e\b/.test(lowered)
  ) {
    return LicenseType.UAE;
  }
  if (
    new RegExp(
      String.raw`\b(?:gcc|saudi|kuwaiti?|qatari?|bahraini?|omani?)[ \t]+${LICENSE_WORD}`,
    ).test(lowered) ||
    new RegExp(
      String.raw`${LICENSE_WORD}[ \t]+(?:from|issued in|of)[ \t]+(?:the[ \t]+)?(?:gcc|saudi|kuwait|qatar|bahrain|oman)`,
    ).test(lowered) ||
    /\bgcc\b/.test(lowered)
  ) {
    return LicenseType.GCC;
  }
  if (
    /\b(?:idp|international[ \t]+driving[ \t]+(?:permit|licen[cs]e)|international[ \t]+(?:licen[cs]e|permit)|international[ \t]+driver'?s?[ \t]+(?:permit|licen[cs]e))\b/.test(
      lowered,
    )
  ) {
    return LicenseType.IDP;
  }
  if (
    /\b(?:foreign|home[ \t]+country|my[ \t]+country|own[ \t]+country|overseas)[ \t]+(?:driving[ \t]+)?(?:licen[cs]e|permit)\b/.test(
      lowered,
    )
  ) {
    return LicenseType.FOREIGN;
  }
  // "Indian licence" / "licence from India": a national licence of a non-UAE/GCC country.
  if (licensePhraseCandidates(lowered).some(phraseNamesACountry)) {
    return LicenseType.FOREIGN;
  }
  return null;
}

// Horizontal whitespace only ([ \t], never \s): see the comment above
// LICENSE_WORD — the same "unrelated line feeds into the next line's label"
// risk applies here (a bare "No" answering some other question must never
// be read as "no passport" purely for landing before a "Passport:" label).
const PASSPORT_NO =
  /(?:\b(?:no|don'?t have|do not have|dont have|without|lost|forgot|not carrying)[ \t]+(?:a[ \t]+|my[ \t]+|any[ \t]+|the[ \t]+)?(?:valid[ \t]+)?passport\b|\bpassport[ \t]*[:-]?[ \t]*(?:no|not available|nahi|nahin)\b)/;
const PASSPORT_YES =
  /(?:\b(?:have|hold|carry|got|has)[ \t]+(?:a[ \t]+|my[ \t]+|the[ \t]+)?(?:valid[ \t]+)?passport\b|\bpassport[ \t]*[:-]?[ \t]*(?:yes|yep|available|ready|valid|with me|haan|ha)\b|\b(?:can|will)[ \t]+(?:provide|show|share|send|submit)[ \t]+(?:my[ \t]+|the[ \t]+)?passport\b|\bpassport[ \t]+(?:is[ \t]+)?(?:valid|available|ready|with me)\b)/;

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
  // Reuses `LICENSE_PHRASE_BEFORE_RE` (horizontal whitespace only, [ \t],
  // never \s) rather than its own copy of the same grammar, so the two can
  // never drift apart on what counts as a licence phrase. \s would match a
  // newline: a customer answering several questions on separate lines
  // ("Nationality: Indian\nDriving licence: ...") must never have "Indian"
  // read as if it modified the *next* line's "Driving licence" label —
  // that would silently erase the nationality answer.
  const stripped = normalizeForCountryLookup(
    text.toLowerCase().replace(LICENSE_PHRASE_BEFORE_RE, ' '),
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
