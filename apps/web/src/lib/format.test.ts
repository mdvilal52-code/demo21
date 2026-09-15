import { describe, expect, it } from 'vitest';
import { formatFieldName } from './format.js';

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
