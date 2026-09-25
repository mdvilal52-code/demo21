import { describe, expect, it } from 'vitest';
import {
  buildTotpEnrollmentUri,
  generateCurrentTotpCode,
  generateTotpSecret,
  verifyTotpCode,
} from './totp.js';

describe('TOTP MFA', () => {
  it('generates a unique secret each time', () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  it('verifies a code generated from the same secret', async () => {
    const secret = generateTotpSecret();
    const code = await generateCurrentTotpCode(secret);
    expect(await verifyTotpCode(secret, code)).toBe(true);
  });

  it('rejects a code generated from a different secret', async () => {
    const code = await generateCurrentTotpCode(generateTotpSecret());
    expect(await verifyTotpCode(generateTotpSecret(), code)).toBe(false);
  });

  it('rejects a garbage code without throwing', async () => {
    expect(await verifyTotpCode(generateTotpSecret(), '000000')).toBe(false);
  });

  it('builds a scannable otpauth:// enrollment URI carrying issuer and account', () => {
    const uri = buildTotpEnrollmentUri({
      secret: generateTotpSecret(),
      accountEmail: 'ops@example.com',
      issuer: 'AI Concierge',
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('AI%20Concierge');
    expect(uri).toContain('ops%40example.com');
  });
});
