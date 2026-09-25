import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMetaSignature } from './signature.js';

const SECRET = 'a-real-looking-app-secret-value';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

describe('verifyMetaSignature', () => {
  it('accepts a correctly signed body', () => {
    const body = '{"object":"whatsapp_business_account"}';
    expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a tampered body signed for different content', () => {
    const signed = sign('{"a":1}');
    expect(verifyMetaSignature('{"a":2}', signed, SECRET)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const body = '{"a":1}';
    expect(verifyMetaSignature(body, sign(body, 'wrong-secret'), SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyMetaSignature('{"a":1}', undefined, SECRET)).toBe(false);
  });

  it('rejects a header missing the sha256= prefix', () => {
    const body = '{"a":1}';
    const raw = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
    expect(verifyMetaSignature(body, raw, SECRET)).toBe(false);
  });

  it('rejects a malformed (non-hex) signature without throwing', () => {
    expect(verifyMetaSignature('{"a":1}', 'sha256=not-hex-!!zz', SECRET)).toBe(false);
  });

  it('rejects a correct signature with trailing garbage appended (not exactly 64 hex chars)', () => {
    const body = '{"a":1}';
    expect(verifyMetaSignature(body, `${sign(body)}extra`, SECRET)).toBe(false);
  });
});
