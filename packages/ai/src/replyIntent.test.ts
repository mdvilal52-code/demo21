import { describe, expect, it } from 'vitest';
import { classifyShortReply, ShortReplyIntent } from './replyIntent.js';

describe('classifyShortReply', () => {
  it.each([
    'Yes',
    'yes',
    'Yes!',
    'Yeah',
    'yep',
    'yup',
    'Sure',
    'Sure, sounds good',
    'Ok',
    'okay',
    'Yes please',
    'Please do',
    'Go ahead',
    'Definitely',
    'Absolutely',
    "Yes, that's correct",
  ])('classifies %j as AFFIRMATIVE', (message) => {
    expect(classifyShortReply(message)).toBe(ShortReplyIntent.AFFIRMATIVE);
  });

  it.each([
    'No',
    'no',
    'No thanks',
    'Nope',
    'Nah',
    'not now',
    'Not interested',
    'never mind',
    'Cancel',
  ])('classifies %j as NEGATIVE', (message) => {
    expect(classifyShortReply(message)).toBe(ShortReplyIntent.NEGATIVE);
  });

  it.each(['Lamborghini Urus', 'Dubai Marina, 15 Oct', 'not sure', '', '   ', 'maybe later'])(
    'classifies %j as UNCLEAR',
    (message) => {
      expect(classifyShortReply(message)).toBe(ShortReplyIntent.UNCLEAR);
    },
  );

  it('prefers NEGATIVE over AFFIRMATIVE when a negation wraps an affirmative-looking word', () => {
    expect(classifyShortReply('no thanks')).toBe(ShortReplyIntent.NEGATIVE);
    expect(classifyShortReply('not really')).toBe(ShortReplyIntent.NEGATIVE);
  });

  it('never matches a substring inside an unrelated word', () => {
    // "sure" inside "insurance", "ok" inside "broken" — word-boundary only.
    expect(classifyShortReply('I need insurance for the car')).toBe(ShortReplyIntent.UNCLEAR);
    expect(classifyShortReply('the AC is broken')).toBe(ShortReplyIntent.UNCLEAR);
  });
});
