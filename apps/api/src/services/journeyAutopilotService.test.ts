import { describe, expect, it } from 'vitest';
import { acceptsQuote, wantsHuman } from './journeyAutopilotService.js';

describe('wantsHuman', () => {
  it.each([
    'I want to speak to a human agent',
    'can I talk to someone from your team please',
    'please connect me with a manager',
    'I need a real person',
    'Customer service please',
    'call me',
    'mujhe manager se baat karni hai',
    'Put me through to a representative',
  ])('recognises "%s"', (text) => {
    expect(wantsHuman(text)).toBe(true);
  });

  it.each([
    'I would like to rent a Lamborghini Urus',
    'what is the price for 3 days',
    'my nationality is Indian',
    'the agent at the airport gave me your number',
    'yes',
  ])('does not misread "%s"', (text) => {
    expect(wantsHuman(text)).toBe(false);
  });
});

describe('acceptsQuote', () => {
  it.each([
    'Yes please, go ahead',
    'confirm',
    "I'll take it",
    'sounds good, book it',
    'Deal!',
    'haan kar do',
    "let's proceed",
  ])('treats "%s" as acceptance', (text) => {
    expect(acceptsQuote(text)).toBe(true);
  });

  it.each([
    'What is included in the price?',
    'how does the deposit work',
    'can you make it cheaper',
    'ok thanks',
    'I need to think about it',
  ])('does not treat "%s" as acceptance', (text) => {
    expect(acceptsQuote(text)).toBe(false);
  });

  it('does not treat a long question that happens to contain "confirm" as acceptance', () => {
    expect(
      acceptsQuote(
        'Could you please confirm whether the deposit is refundable and how long the refund takes after I return the car',
      ),
    ).toBe(false);
  });
});
