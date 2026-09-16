import { describe, expect, it } from 'vitest';
import { AnswerExtractionService } from './answerExtractionService.js';

describe('AnswerExtractionService.extractStructuredCandidates', () => {
  const service = new AnswerExtractionService();

  it('extracts a flight number', () => {
    const candidates = service.extractStructuredCandidates('My flight is EK203, landing at 3pm');
    expect(candidates).toContainEqual({ field: 'FLIGHT_NUMBER', value: 'EK203' });
  });

  it('extracts a flight number written with a space or hyphen', () => {
    const spaced = service.extractStructuredCandidates('Flight BA 1379 please');
    expect(spaced).toContainEqual({ field: 'FLIGHT_NUMBER', value: 'BA1379' });

    const hyphenated = service.extractStructuredCandidates('Flight EK-203 please');
    expect(hyphenated).toContainEqual({ field: 'FLIGHT_NUMBER', value: 'EK203' });
  });

  it('extracts a flight number typed in lowercase', () => {
    const candidates = service.extractStructuredCandidates('my flight is ek203');
    expect(candidates).toContainEqual({ field: 'FLIGHT_NUMBER', value: 'EK203' });
  });

  it('extracts a 12-hour pickup time and normalizes to 24h', () => {
    const candidates = service.extractStructuredCandidates('please have it ready at 3pm');
    expect(candidates).toContainEqual({ field: 'PICKUP_TIME', value: '15:00' });
  });

  it('extracts a 24-hour pickup time as-is', () => {
    const candidates = service.extractStructuredCandidates('pickup at 15:30 works for me');
    expect(candidates).toContainEqual({ field: 'PICKUP_TIME', value: '15:30' });
  });

  it('normalizes 12am and 12pm correctly', () => {
    const midnight = service.extractStructuredCandidates('ready by 12am');
    expect(midnight).toContainEqual({ field: 'PICKUP_TIME', value: '00:00' });

    const noon = service.extractStructuredCandidates('ready by 12pm');
    expect(noon).toContainEqual({ field: 'PICKUP_TIME', value: '12:00' });
  });

  it('never treats a bare number as a time', () => {
    const candidates = service.extractStructuredCandidates('I need 5 seats for 2 people');
    expect(candidates.some((c) => c.field === 'PICKUP_TIME')).toBe(false);
  });

  it('extracts a driver-required signal', () => {
    const candidates = service.extractStructuredCandidates('I need a driver please');
    expect(candidates).toContainEqual({ field: 'DRIVER_REQUIREMENT', value: true });
  });

  it('extracts a self-drive signal', () => {
    const candidates = service.extractStructuredCandidates('self-drive is fine for us');
    expect(candidates).toContainEqual({ field: 'DRIVER_REQUIREMENT', value: false });
  });

  it('extracts both driver-requirement signals when the message contains both (contradiction upstream)', () => {
    const candidates = service.extractStructuredCandidates(
      'self-drive please, actually no I need a driver',
    );
    const driverValues = candidates
      .filter((c) => c.field === 'DRIVER_REQUIREMENT')
      .map((c) => c.value);
    expect(driverValues.sort()).toEqual([false, true]);
  });

  it('flips a negated driver-required phrase to self-drive', () => {
    const candidates = service.extractStructuredCandidates(
      "I don't need a driver, I'll drive myself",
    );
    expect(candidates).toContainEqual({ field: 'DRIVER_REQUIREMENT', value: false });
    expect(candidates.filter((c) => c.field === 'DRIVER_REQUIREMENT')).toHaveLength(1);
  });

  it('flips a negated self-drive phrase to driver-required', () => {
    const candidates = service.extractStructuredCandidates("I don't want self-drive, thanks");
    expect(candidates).toContainEqual({ field: 'DRIVER_REQUIREMENT', value: true });
    expect(candidates.filter((c) => c.field === 'DRIVER_REQUIREMENT')).toHaveLength(1);
  });

  it('extracts an email as contact details', () => {
    const candidates = service.extractStructuredCandidates(
      'reach me at jane.doe@example.com please',
    );
    expect(candidates).toContainEqual({ field: 'CONTACT_DETAILS', value: 'jane.doe@example.com' });
  });

  it('extracts a phone number as contact details', () => {
    const candidates = service.extractStructuredCandidates('call me on +971 50 123 4567');
    expect(candidates.some((c) => c.field === 'CONTACT_DETAILS')).toBe(true);
  });

  it('produces at most one contact-details candidate when the message has both an email and a phone', () => {
    const candidates = service.extractStructuredCandidates(
      'call me at 0501234567 or email jane@example.com',
    );
    const contactCandidates = candidates.filter((c) => c.field === 'CONTACT_DETAILS');
    expect(contactCandidates).toHaveLength(1);
    expect(contactCandidates[0]?.value).toBe('jane@example.com'); // email preferred when both present
  });

  it('never produces a contact-details candidate longer than the field allows', () => {
    const candidates = service.extractStructuredCandidates(`call me on +${'1'.repeat(300)}`);
    const contactCandidates = candidates.filter((c) => c.field === 'CONTACT_DETAILS');
    for (const candidate of contactCandidates) {
      expect((candidate.value as string).length).toBeLessThanOrEqual(200);
    }
  });

  it('returns no candidates for an unrelated message', () => {
    const candidates = service.extractStructuredCandidates('What is the weather like in Dubai?');
    expect(candidates).toEqual([]);
  });
});

describe('AnswerExtractionService.extractFreeTextAnswer', () => {
  const service = new AnswerExtractionService();

  it('captures the sanitized text as a dropoff address when unanchored capture is allowed', () => {
    const candidate = service.extractFreeTextAnswer(
      'DROPOFF_ADDRESS',
      'Marina Heights Tower, Unit 402',
      { allowUnanchoredCapture: true },
    );
    expect(candidate).toEqual({
      field: 'DROPOFF_ADDRESS',
      value: 'Marina Heights Tower, Unit 402',
    });
  });

  it('captures just the anchored phrase for an explicit "drop off at" mention, even mid-sentence', () => {
    const candidate = service.extractFreeTextAnswer(
      'DROPOFF_ADDRESS',
      'Pickup at 3pm, drop off at Burj Al Arab',
      { allowUnanchoredCapture: false },
    );
    expect(candidate).toEqual({ field: 'DROPOFF_ADDRESS', value: 'Burj Al Arab' });
  });

  it('trims trailing unrelated content (a phone number) out of the captured address', () => {
    const candidate = service.extractFreeTextAnswer(
      'DROPOFF_ADDRESS',
      'drop off at Burj Al Arab, my number is 0501234567',
      { allowUnanchoredCapture: false },
    );
    expect(candidate).toEqual({ field: 'DROPOFF_ADDRESS', value: 'Burj Al Arab' });
  });

  it('trims the captured address at a sentence boundary', () => {
    const candidate = service.extractFreeTextAnswer(
      'DROPOFF_ADDRESS',
      'drop off at Burj Al Arab. Also I have 2 bags',
      { allowUnanchoredCapture: false },
    );
    expect(candidate).toEqual({ field: 'DROPOFF_ADDRESS', value: 'Burj Al Arab' });
  });

  it('never leaks the [REMOVED] sanitizer placeholder into a stored address', () => {
    // Text as it actually arrives here: already run through sanitizeForProcessing upstream.
    const candidate = service.extractFreeTextAnswer(
      'DROPOFF_ADDRESS',
      'drop off at 55 Main St, [REMOVED]',
      { allowUnanchoredCapture: false },
    );
    expect(candidate?.value).not.toContain('[REMOVED]');
    expect(candidate).toEqual({ field: 'DROPOFF_ADDRESS', value: '55 Main St,' });
  });

  it('never captures an unanchored address when the message was already explained by other data', () => {
    const candidate = service.extractFreeTextAnswer(
      'DROPOFF_ADDRESS',
      'My flight is EK203, I need a driver, contact me at jane@example.com',
      { allowUnanchoredCapture: false },
    );
    expect(candidate).toBeNull();
  });

  it('captures a short explicit decline as a special-requests answer when unanchored capture is allowed', () => {
    const candidate = service.extractFreeTextAnswer('SPECIAL_REQUESTS', 'no special requests', {
      allowUnanchoredCapture: true,
    });
    expect(candidate).toEqual({ field: 'SPECIAL_REQUESTS', value: 'no special requests' });
  });

  it('never captures special requests when unanchored capture is disallowed', () => {
    const candidate = service.extractFreeTextAnswer('SPECIAL_REQUESTS', 'no special requests', {
      allowUnanchoredCapture: false,
    });
    expect(candidate).toBeNull();
  });

  it('returns null when nothing meaningful remains after sanitization', () => {
    const candidate = service.extractFreeTextAnswer('DROPOFF_ADDRESS', '[REMOVED]', {
      allowUnanchoredCapture: true,
    });
    expect(candidate).toBeNull();
  });

  it('truncates text longer than the field bound instead of throwing', () => {
    const longText = 'a'.repeat(1000);
    const candidate = service.extractFreeTextAnswer('SPECIAL_REQUESTS', longText, {
      allowUnanchoredCapture: true,
    });
    expect(typeof candidate?.value).toBe('string');
    expect((candidate?.value as string).length).toBeLessThanOrEqual(500);
  });
});
