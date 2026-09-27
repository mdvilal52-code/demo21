import { describe, expect, it } from 'vitest';
import { extractContact } from './contactExtraction.js';

describe('extractContact', () => {
  it('reads an email address and lowercases it', () => {
    expect(extractContact('you can mail me at Ahmed.Ali@Example.com thanks').email).toBe(
      'ahmed.ali@example.com',
    );
  });

  it('reads an international phone number into E.164', () => {
    expect(extractContact('my number is +971 50 123 4567').phone).toBe('+971501234567');
    expect(extractContact('call 00971501234567 please').phone).toBe('+971501234567');
  });

  it('reads a UAE mobile written locally', () => {
    expect(extractContact('050 123 4567').phone).toBe('+971501234567');
    expect(extractContact('whatsapp me on 0501234567').phone).toBe('+971501234567');
  });

  it('reads a cue-announced number without a country code only when it looks like a UAE mobile', () => {
    expect(extractContact('my mobile is 501234567').phone).toBe('+971501234567');
  });

  it('does not mistake dates, prices or ids for a phone number', () => {
    expect(extractContact('from 2026-10-10 to 2026-10-14').phone).toBeUndefined();
    expect(extractContact('10/10/2026').phone).toBeUndefined();
    expect(extractContact('the total is AED 7,612.50').phone).toBeUndefined();
    expect(extractContact('passport 12345678').phone).toBeUndefined();
    expect(extractContact('I was born 12 May 1990').phone).toBeUndefined();
  });

  it('rejects numbers that are too short or too long', () => {
    expect(extractContact('call me on +12345').phone).toBeUndefined();
    expect(extractContact('call me on +1234567890123456789').phone).toBeUndefined();
  });

  it('reads an announced name and nothing else', () => {
    expect(extractContact('my name is ahmed al mansoori').displayName).toBe('Ahmed Al Mansoori');
    expect(extractContact('call me back later').displayName).toBeUndefined();
    expect(extractContact('I am Indian national').displayName).toBeUndefined();
    expect(extractContact('I want the Range Rover').displayName).toBeUndefined();
  });

  it('reads everything from one message', () => {
    expect(
      extractContact('Hi, my name is Sara. Email sara@example.com, phone +44 20 7946 0958'),
    ).toEqual({ email: 'sara@example.com', phone: '+442079460958', displayName: 'Sara' });
  });

  it('returns nothing for a message without contact details', () => {
    expect(extractContact('I want to rent a car in Dubai')).toEqual({});
  });
});
