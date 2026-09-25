import { describe, expect, it } from 'vitest';
import { formatEnumLabel, formatFieldName } from './format.js';

describe('formatFieldName', () => {
  it('splits camelCase into words', () => {
    expect(formatFieldName('vehicleIntent')).toBe('Vehicle Intent');
  });

  it('capitalizes the first letter', () => {
    expect(formatFieldName('location')).toBe('Location');
  });

  it('handles multiple capital letters', () => {
    expect(formatFieldName('pickupDate')).toBe('Pickup Date');
  });
});

describe('formatEnumLabel', () => {
  it('lowercases and joins words after the first', () => {
    expect(formatEnumLabel('AI_UNABLE_TO_PROCEED')).toBe('AI unable to proceed');
  });

  it('title-cases a single word', () => {
    expect(formatEnumLabel('ESCALATED')).toBe('Escalated');
  });

  it('keeps short acronyms upper-case wherever they appear', () => {
    expect(formatEnumLabel('PAYMENT_EXCEPTION')).toBe('Payment exception');
  });
});
