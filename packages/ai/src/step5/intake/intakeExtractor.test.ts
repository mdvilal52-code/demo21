import { describe, expect, it } from 'vitest';
import { EligibilityIntakeField } from '@ai-concierge/domain';
import {
  extractDateOfBirth,
  extractEligibilityIntake,
  stripQuotedReply,
} from './intakeExtractor.js';
import { findCountryInText, lookupCountry } from './countries.js';

const NOW = new Date('2026-09-26T10:00:00.000Z');

function extract(text: string, opts: { asked?: boolean; missing?: string[] } = {}) {
  return extractEligibilityIntake({
    text,
    asked: opts.asked ?? true,
    missing: (opts.missing ?? []) as never,
    now: NOW,
  });
}

describe('extractDateOfBirth', () => {
  it('reads an ISO date after a birth cue', () => {
    expect(extractDateOfBirth('I was born on 1990-05-12', false, NOW).value).toBe('1990-05-12');
  });

  it('reads "12 May 1990" and ordinal / "of" variants', () => {
    expect(extractDateOfBirth('DOB: 12 May 1990', false, NOW).value).toBe('1990-05-12');
    expect(extractDateOfBirth('born 12th of May, 1990', false, NOW).value).toBe('1990-05-12');
    expect(extractDateOfBirth('born May 12, 1990', false, NOW).value).toBe('1990-05-12');
  });

  it('reads an unambiguous numeric date (a part above 12 is the day)', () => {
    expect(extractDateOfBirth('dob 25/03/1988', false, NOW).value).toBe('1988-03-25');
    expect(extractDateOfBirth('dob 03/25/1988', false, NOW).value).toBe('1988-03-25');
    expect(extractDateOfBirth('dob 05/05/1990', false, NOW).value).toBe('1990-05-05');
  });

  it('refuses an ambiguous DD/MM vs MM/DD date and flags it', () => {
    expect(extractDateOfBirth('dob 03/04/1990', false, NOW)).toEqual({
      value: null,
      ambiguous: true,
    });
  });

  it('does not mistake a future pickup date for a date of birth', () => {
    expect(
      extractDateOfBirth('Pickup 12 October 2026, return 15 October 2026', true, NOW).value,
    ).toBeNull();
  });

  it('picks the birth date when a pickup date shares the message', () => {
    expect(
      extractDateOfBirth('pickup 12 October 2026, I was born 4 June 1991', true, NOW).value,
    ).toBe('1991-06-04');
  });

  it('accepts a bare date only when we asked and it is the sole plausible date', () => {
    expect(extractDateOfBirth('12 May 1990', true, NOW).value).toBe('1990-05-12');
    expect(extractDateOfBirth('12 May 1990', false, NOW).value).toBeNull();
    expect(extractDateOfBirth('12 May 1990 and 3 June 1985', true, NOW).value).toBeNull();
  });

  it('rejects impossible dates, too-young and implausibly old dates', () => {
    expect(extractDateOfBirth('born 31 February 1990', false, NOW).value).toBeNull();
    expect(extractDateOfBirth('born 1 May 2015', false, NOW).value).toBeNull();
    expect(extractDateOfBirth('born 1 May 1901', false, NOW).value).toBeNull();
  });
});

describe('countries', () => {
  it('maps names and demonyms to ISO codes', () => {
    expect(lookupCountry('Indian')).toBe('IN');
    expect(lookupCountry('the UAE')).toBe('AE');
    expect(lookupCountry('sri lankan')).toBe('LK');
    expect(lookupCountry('atlantis')).toBeNull();
  });

  it('returns null when a text names two different countries', () => {
    expect(findCountryInText('Indian living in UAE')).toBeNull();
    expect(findCountryInText('I am Pakistani')).toBe('PK');
  });
});

describe('extractEligibilityIntake — nationality', () => {
  it('reads an explicit cue', () => {
    expect(extract('My nationality is British', { asked: false }).patch.nationality).toBe('GB');
    expect(extract("I'm an American citizen", { asked: false }).patch.nationality).toBe('US');
    expect(extract('Indian passport holder', { asked: false }).patch.nationality).toBe('IN');
  });

  it('reads a bare short answer only after we asked', () => {
    expect(extract('Indian', { asked: true }).patch.nationality).toBe('IN');
    expect(extract('Indian', { asked: false }).patch.nationality).toBeUndefined();
  });

  it('does not treat "UAE licence" as a UAE nationality', () => {
    const { patch } = extract('I have a UAE licence', { asked: true });
    expect(patch.nationality).toBeUndefined();
    expect(patch.licenseType).toBe('UAE');
  });

  it('ignores a country that only appears in a long, cue-less message', () => {
    const long =
      'I would like to collect the car near the Saudi German hospital and drop it at the airport terminal three next Friday afternoon please';
    expect(extract(long, { asked: true }).patch.nationality).toBeUndefined();
  });
});

describe('extractEligibilityIntake — licence', () => {
  it.each([
    ['I hold a UAE driving licence', 'UAE'],
    ['emirates license', 'UAE'],
    ['I have a GCC licence', 'GCC'],
    ['Saudi driving license', 'GCC'],
    ['I have an international driving permit', 'IDP'],
    ['IDP and my Indian licence', 'IDP'],
    ['I have an Indian driving licence', 'FOREIGN'],
    ['licence from Germany', 'FOREIGN'],
    ['my home country license', 'FOREIGN'],
  ])('%s -> %s (valid)', (text, type) => {
    const { patch } = extract(text);
    expect(patch.licenseType).toBe(type);
    expect(patch.hasValidLicense).toBe(true);
  });

  it('marks an expired or suspended licence invalid', () => {
    const { patch } = extract('my UAE licence expired last month');
    expect(patch.licenseType).toBe('UAE');
    expect(patch.hasValidLicense).toBe(false);
  });

  it('records "no licence" as an invalid licence rather than dropping the answer', () => {
    const { patch } = extract("I don't have a driving licence");
    expect(patch.hasValidLicense).toBe(false);
    expect(patch.licenseType).toBeDefined();
  });

  it('leaves the type unset for a bare "licence" mention', () => {
    expect(extract('yes I have a licence').patch.licenseType).toBeUndefined();
  });
});

describe('extractEligibilityIntake — passport', () => {
  it.each([
    ['I have my passport', true],
    ['passport: yes', true],
    ['I can send my passport', true],
    ['no passport', false],
    ["I don't have a passport", false],
    ['passport - no', false],
  ])('%s -> %s', (text, expected) => {
    expect(extract(text).patch.passportProvided).toBe(expected);
  });
});

describe('extractEligibilityIntake — bare yes/no', () => {
  it('binds to the only open yes/no question', () => {
    const missing = [EligibilityIntakeField.PASSPORT];
    expect(extract('yes', { missing }).patch.passportProvided).toBe(true);
    expect(extract('nahi', { missing }).patch.passportProvided).toBe(false);
  });

  it('does not guess when more than one field is open', () => {
    const missing = [EligibilityIntakeField.PASSPORT, EligibilityIntakeField.LICENSE_VALID];
    expect(extract('yes', { missing }).patch).toEqual({});
  });

  it('does not bind when we had not asked', () => {
    const missing = [EligibilityIntakeField.PASSPORT];
    expect(extract('yes', { missing, asked: false }).patch).toEqual({});
  });
});

describe('extractEligibilityIntake — everything in one message', () => {
  it('extracts all five fields from a single natural reply', () => {
    const { patch } = extract(
      "I'm Indian, born 12 May 1990, I have a UAE driving licence and my passport is with me",
    );
    expect(patch).toEqual({
      dateOfBirth: '1990-05-12',
      nationality: 'IN',
      licenseType: 'UAE',
      hasValidLicense: true,
      passportProvided: true,
    });
  });
});

describe('stripQuotedReply', () => {
  it('drops quoted lines and the "On ... wrote:" tail so our own example date is not read back', () => {
    const reply = [
      'Indian, 3 April 1991, UAE licence, passport yes',
      '',
      'On Sat, 26 Sep 2026 at 10:00, Edel & Stark <concierge@example.com> wrote:',
      '> Please send your date of birth (for example 12 May 1990)',
    ].join('\n');
    expect(stripQuotedReply(reply)).toBe('Indian, 3 April 1991, UAE licence, passport yes');
    expect(extract(stripQuotedReply(reply)).patch.dateOfBirth).toBe('1991-04-03');
  });

  it('handles Outlook-style original-message separators and bare > quoting', () => {
    expect(stripQuotedReply('Yes\n-----Original Message-----\nFrom: x\nborn 12 May 1990')).toBe(
      'Yes',
    );
    expect(stripQuotedReply('Yes\n> born 12 May 1990')).toBe('Yes');
  });

  it('leaves a message with no quoting untouched, and never returns an empty string', () => {
    expect(stripQuotedReply('born 12 May 1990')).toBe('born 12 May 1990');
    expect(stripQuotedReply('> only quoted')).toBe('> only quoted');
  });
});
