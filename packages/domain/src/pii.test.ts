import { describe, expect, it } from 'vitest';
import { classifyPII, redactPII } from './pii.js';

describe('classifyPII', () => {
  it('flags no categories for plain text', () => {
    const result = classifyPII('I need a car for the weekend');
    expect(result.containsPii).toBe(false);
    expect(result.categories).toEqual([]);
  });

  it('detects an email address', () => {
    const result = classifyPII('reach me at jane.doe@example.com please');
    expect(result.categories).toContain('EMAIL');
  });

  it('detects a phone number', () => {
    const result = classifyPII('call me on +971 50 123 4567');
    expect(result.categories).toContain('PHONE');
  });

  it('detects a passport-like token', () => {
    const result = classifyPII('my passport is A1234567');
    expect(result.categories).toContain('PASSPORT_LIKE');
  });

  it('is stateless across repeated calls (no lastIndex leakage)', () => {
    const first = classifyPII('contact a@b.com');
    const second = classifyPII('no pii here');
    expect(first.containsPii).toBe(true);
    expect(second.containsPii).toBe(false);
  });
});

describe('redactPII', () => {
  it('replaces an email with a placeholder', () => {
    expect(redactPII('email jane@example.com now')).toBe('email [REDACTED_EMAIL] now');
  });

  it('leaves plain text untouched', () => {
    expect(redactPII('I need a Lamborghini for Friday')).toBe('I need a Lamborghini for Friday');
  });
});
