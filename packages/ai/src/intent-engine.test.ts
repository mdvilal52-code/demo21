import { describe, expect, it } from 'vitest';
import { IntentStatus, IntentType } from '@ai-concierge/domain';
import { RuleBasedIntentEngine } from './intent-engine.js';

const engine = new RuleBasedIntentEngine();
const REFERENCE_DATE = new Date('2026-09-01T09:00:00.000Z');

describe('RuleBasedIntentEngine — normal cases', () => {
  it('recognizes a complete booking request', () => {
    const result = engine.recognize(
      'I want to rent a Lamborghini Urus in Dubai Marina from 15 to 19 October, with a driver',
      { referenceDate: REFERENCE_DATE },
    );
    expect(result.intentType).toBe(IntentType.BOOKING_REQUEST);
    expect(result.entities.vehicleIntent).toBe('lamborghini');
    expect(result.entities.location).toBe('dubai marina');
    expect(result.entities.driverRequired).toBe(true);
    expect(result.entities.pickupDate).toBeDefined();
    expect(result.entities.returnDate).toBeDefined();
    expect(result.status).toBe(IntentStatus.RECOGNIZED);
    expect(result.missingFields).toEqual([]);
  });

  it('recognizes a price request', () => {
    const result = engine.recognize('How much does it cost to rent an SUV for a week?', {
      referenceDate: REFERENCE_DATE,
    });
    expect(result.intentType).toBe(IntentType.PRICE_REQUEST);
  });

  it('recognizes a complaint', () => {
    const result = engine.recognize('This is a terrible experience, I am very unhappy and angry', {
      referenceDate: REFERENCE_DATE,
    });
    expect(result.intentType).toBe(IntentType.COMPLAINT);
  });

  it('extracts passenger count', () => {
    const result = engine.recognize('I need a van for 6 passengers next Friday', {
      referenceDate: REFERENCE_DATE,
    });
    expect(result.entities.passengerCount).toBe(6);
  });

  it('detects high urgency language', () => {
    const result = engine.recognize('I need a car urgently, asap please', {
      referenceDate: REFERENCE_DATE,
    });
    expect(result.entities.urgency).toBe('HIGH');
  });
});

describe('RuleBasedIntentEngine — clarification and edge cases', () => {
  it('extremely long message does not crash and is still classified', () => {
    const longMessage = `I want to rent a car. ${'Please help me. '.repeat(500)}`;
    const result = engine.recognize(longMessage, { referenceDate: REFERENCE_DATE });
    expect(result).toBeDefined();
    expect(result.entities.language).toBe('en');
  });

  it('missing date on a booking request triggers NEEDS_CLARIFICATION with missingFields', () => {
    const result = engine.recognize('I want to rent a Lamborghini in Dubai', {
      referenceDate: REFERENCE_DATE,
    });
    expect(result.intentType).toBe(IntentType.BOOKING_REQUEST);
    expect(result.status).toBe(IntentStatus.NEEDS_CLARIFICATION);
    expect(result.missingFields).toContain('pickupDate');
    expect(result.clarificationPrompt).toBeDefined();
  });

  it('an ambiguous date phrase does not get resolved into a concrete date', () => {
    const result = engine.recognize('I want to rent a car next week sometime', {
      referenceDate: REFERENCE_DATE,
    });
    expect(result.entities.pickupDate).toBeUndefined();
    expect(result.status).toBe(IntentStatus.NEEDS_CLARIFICATION);
  });

  it('an unrecognized vehicle is never hallucinated into a guess', () => {
    const result = engine.recognize('I want to book a spaceship for tomorrow in Dubai', {
      referenceDate: REFERENCE_DATE,
    });
    expect(result.entities.vehicleIntent).toBeUndefined();
    expect(result.missingFields).toContain('vehicleIntent');
  });

  it('an unsupported, off-topic request is classified as UNKNOWN', () => {
    const result = engine.recognize('Can you tell me the weather forecast for tomorrow?', {
      referenceDate: REFERENCE_DATE,
    });
    expect(result.intentType).toBe(IntentType.UNKNOWN);
  });

  it('multilingual (Arabic script) input is language-tagged without breaking extraction', () => {
    const result = engine.recognize('أحتاج سيارة في دبي غدا', { referenceDate: REFERENCE_DATE });
    expect(result.entities.language).toBe('ar');
    expect(result).toBeDefined();
  });

  it('never fabricates entities that were not present in the message', () => {
    const result = engine.recognize('Hello, is anyone there?', { referenceDate: REFERENCE_DATE });
    expect(result.entities.vehicleIntent).toBeUndefined();
    expect(result.entities.pickupDate).toBeUndefined();
    expect(result.entities.location).toBeUndefined();
    expect(result.entities.passengerCount).toBeUndefined();
  });
});
