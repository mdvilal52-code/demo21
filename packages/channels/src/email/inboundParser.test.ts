import { describe, expect, it } from 'vitest';
import { parseMailgunInboundEmail } from './inboundParser.js';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    sender: 'customer@example.com',
    recipient: 'concierge@fleet.example.com',
    subject: 'Booking enquiry',
    'body-plain': 'I want to rent a Lamborghini Urus 15-19 Oct, Dubai',
    'Message-Id': '<abc123@mail.example.com>',
    timestamp: '1758700000',
    token: 'a-single-use-token',
    signature: 'irrelevant-here-verified-separately',
    ...overrides,
  };
}

describe('parseMailgunInboundEmail', () => {
  it('extracts a real inbound email', () => {
    const result = parseMailgunInboundEmail(payload());
    expect(result).toEqual({
      messageId: '<abc123@mail.example.com>',
      from: 'customer@example.com',
      subject: 'Booking enquiry',
      body: 'I want to rent a Lamborghini Urus 15-19 Oct, Dubai',
    });
  });

  it('prefers stripped-text over body-plain when both are present (quoted-reply trimming)', () => {
    const result = parseMailgunInboundEmail(
      payload({
        'body-plain': 'Yes please\n\nOn Mon, ... wrote:\n> original message',
        'stripped-text': 'Yes please',
      }),
    );
    expect(result?.body).toBe('Yes please');
  });

  it('falls back to a timestamp:token id when Message-Id is missing', () => {
    const result = parseMailgunInboundEmail(payload({ 'Message-Id': undefined }));
    expect(result?.messageId).toBe('1758700000:a-single-use-token');
  });

  it('returns null for an empty body rather than a blank message', () => {
    const result = parseMailgunInboundEmail(payload({ 'body-plain': '   ', 'stripped-text': '' }));
    expect(result).toBeNull();
  });

  it('returns null (never throws) for a malformed/wrong-typed payload', () => {
    expect(parseMailgunInboundEmail({ sender: 123, recipient: null })).toBeNull();
    expect(parseMailgunInboundEmail('not an object')).toBeNull();
    expect(parseMailgunInboundEmail(null)).toBeNull();
    expect(parseMailgunInboundEmail(undefined)).toBeNull();
  });

  it('returns null for a prototype-pollution-shaped payload without throwing', () => {
    const malicious = JSON.parse(
      '{"__proto__": {"polluted": true}, "sender": "a@b.com", "recipient": "c@d.com", "body-plain": "hi", "timestamp": "1", "token": "t", "signature": "s"}',
    );
    expect(() => parseMailgunInboundEmail(malicious)).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
