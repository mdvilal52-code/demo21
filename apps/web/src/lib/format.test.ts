import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatEnumLabel,
  formatFieldName,
  formatMoney,
} from './format.js';

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

describe('formatMoney', () => {
  it('shows whole amounts without decimals and cents with exactly two', () => {
    expect(formatMoney(1470000, 'AED')).toBe('AED 14,700');
    expect(formatMoney(1475250, 'AED')).toBe('AED 14,752.50');
    expect(formatMoney(5, 'AED')).toBe('AED 0.05');
    expect(formatMoney(0, 'AED')).toBe('AED 0');
  });
});

describe('formatDateTime', () => {
  it('renders Dubai time with a stable month name', () => {
    expect(formatDateTime('2026-09-26T09:05:00.000Z')).toBe('26 Sep 2026, 13:05');
    expect(formatDateTime('2026-01-01T21:30:00.000Z')).toBe('2 Jan 2026, 01:30');
  });
});

describe('formatDate', () => {
  it('renders just the Dubai date', () => {
    expect(formatDate('2026-10-15T06:00:00.000Z')).toBe('15 Oct 2026');
  });
});
