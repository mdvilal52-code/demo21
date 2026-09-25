import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWhatsAppTextMessages } from './inboundParser.js';
import { verifyMetaSignature } from './signature.js';

const SECRET = 'a-real-looking-app-secret-value';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
}

describe('WhatsApp channel — security', () => {
  it('never accepts an uppercase or mixed-case "sha256=" prefix as a substitute for the real one', () => {
    const body = '{"a":1}';
    const hex = sign(body).slice('sha256='.length);
    expect(verifyMetaSignature(body, `SHA256=${hex}`, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, `Sha256=${hex}`, SECRET)).toBe(false);
  });

  it('never accepts a signature computed for an empty body when the actual body is non-empty', () => {
    const forged = sign('');
    expect(verifyMetaSignature('{"a":1}', forged, SECRET)).toBe(false);
  });

  it('never throws on an absurdly long (but validly hex) signature value', () => {
    const body = '{"a":1}';
    const overlong = `sha256=${'ab'.repeat(10_000)}`;
    expect(() => verifyMetaSignature(body, overlong, SECRET)).not.toThrow();
    expect(verifyMetaSignature(body, overlong, SECRET)).toBe(false);
  });

  it('never throws on signature header injection attempts (extra data, null bytes, control chars)', () => {
    const body = '{"a":1}';
    const valid = sign(body);
    for (const attempt of [
      `${valid}\nX-Injected: true`,
      `${valid}\u0000extra`,
      'sha256=',
      'sha256=' + 'z'.repeat(64),
    ]) {
      expect(() => verifyMetaSignature(body, attempt, SECRET)).not.toThrow();
      expect(verifyMetaSignature(body, attempt, SECRET)).toBe(false);
    }
  });

  it('never lets a prototype-pollution-shaped payload reach Object.prototype', () => {
    const payload = JSON.parse(
      '{"entry":[{"changes":[{"value":{"messages":[{"__proto__":{"polluted":true},"from":"a","id":"m1","type":"text","text":{"body":"hi"}}]}}]}]}',
    ) as unknown;

    expect(() => parseWhatsAppTextMessages(payload)).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('never throws when "entry"/"changes"/"messages" are the wrong type entirely (objects, numbers, booleans)', () => {
    for (const bogus of [
      { entry: {} },
      { entry: [{ changes: {} }] },
      { entry: [{ changes: [{ value: { messages: 'not-an-array' } }] }] },
      { entry: [{ changes: [{ value: { messages: [42, true, 'x'] } }] }] },
    ]) {
      expect(() => parseWhatsAppTextMessages(bogus)).not.toThrow();
      expect(parseWhatsAppTextMessages(bogus)).toEqual([]);
    }
  });

  it("parses an extremely long message body without throwing (size limits are the HTTP layer's job)", () => {
    const longBody = 'a'.repeat(10_000);
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: '971500000000', id: 'm1', type: 'text', text: { body: longBody } },
                ],
              },
            },
          ],
        },
      ],
    };
    const result = parseWhatsAppTextMessages(payload);
    expect(result).toHaveLength(1);
    expect(result[0]!.body).toHaveLength(10_000);
  });
});
