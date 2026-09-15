import { describe, expect, it } from 'vitest';
import { createEnquiryRequestSchema } from './enquiry.js';

const base = { channel: 'WEB', customerRef: 'web-session-1' } as const;

describe('createEnquiryRequestSchema', () => {
  it('accepts a normal enquiry', () => {
    const result = createEnquiryRequestSchema.safeParse({
      ...base,
      message: 'I would like to rent a car for the weekend',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty message', () => {
    const result = createEnquiryRequestSchema.safeParse({ ...base, message: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a message that is only whitespace', () => {
    const result = createEnquiryRequestSchema.safeParse({ ...base, message: '    ' });
    expect(result.success).toBe(false);
  });

  it('rejects a message longer than 4000 characters', () => {
    const result = createEnquiryRequestSchema.safeParse({ ...base, message: 'a'.repeat(4001) });
    expect(result.success).toBe(false);
  });

  it('accepts a message at exactly the maximum length', () => {
    const result = createEnquiryRequestSchema.safeParse({ ...base, message: 'a'.repeat(4000) });
    expect(result.success).toBe(true);
  });

  it('accepts HTML/script content as plain string data (validation is not sanitization)', () => {
    // Zod's job here is shape/length validation. Escaping happens at render
    // time (React auto-escapes); the intent engine treats it as inert text.
    const result = createEnquiryRequestSchema.safeParse({
      ...base,
      message: '<script>alert(1)</script>',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid channel', () => {
    const result = createEnquiryRequestSchema.safeParse({
      channel: 'CARRIER_PIGEON',
      customerRef: 'x',
      message: 'hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing customerRef', () => {
    const result = createEnquiryRequestSchema.safeParse({ channel: 'WEB', message: 'hello' });
    expect(result.success).toBe(false);
  });

  it('rejects an oversized customerRef', () => {
    const result = createEnquiryRequestSchema.safeParse({
      channel: 'WEB',
      customerRef: 'a'.repeat(201),
      message: 'hello',
    });
    expect(result.success).toBe(false);
  });
});
