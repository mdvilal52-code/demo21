import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMailgunSignature } from './signature.js';

const SIGNING_KEY = 'a-real-looking-mailgun-signing-key';

function sign(timestamp: string, token: string, key = SIGNING_KEY): string {
  return createHmac('sha256', key).update(`${timestamp}${token}`, 'utf8').digest('hex');
}

describe('verifyMailgunSignature', () => {
  it('accepts a correctly signed timestamp+token pair', () => {
    const timestamp = '1758700000';
    const token = 'a-single-use-token';
    expect(verifyMailgunSignature(timestamp, token, sign(timestamp, token), SIGNING_KEY)).toBe(
      true,
    );
  });

  it('rejects a signature computed for a different token', () => {
    const timestamp = '1758700000';
    expect(
      verifyMailgunSignature(timestamp, 'token-b', sign(timestamp, 'token-a'), SIGNING_KEY),
    ).toBe(false);
  });

  it('rejects a signature computed with the wrong signing key', () => {
    const timestamp = '1758700000';
    const token = 'a-single-use-token';
    expect(
      verifyMailgunSignature(timestamp, token, sign(timestamp, token, 'wrong-key'), SIGNING_KEY),
    ).toBe(false);
  });

  it('rejects a malformed (non-hex) signature without throwing', () => {
    expect(verifyMailgunSignature('1758700000', 'tok', 'not-hex-!!zz', SIGNING_KEY)).toBe(false);
  });
});
