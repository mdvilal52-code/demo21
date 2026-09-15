import { describe, expect, it } from 'vitest';
import { generateCsrfToken, verifyCsrfToken } from './csrf.js';

describe('csrf double-submit primitive', () => {
  it('generates tokens of sufficient length', () => {
    const token = generateCsrfToken();
    expect(token).toHaveLength(64);
  });

  it('verifies matching cookie and header tokens', () => {
    const token = generateCsrfToken();
    expect(verifyCsrfToken(token, token)).toBe(true);
  });

  it('rejects mismatched tokens', () => {
    expect(verifyCsrfToken(generateCsrfToken(), generateCsrfToken())).toBe(false);
  });

  it('rejects when either side is missing', () => {
    const token = generateCsrfToken();
    expect(verifyCsrfToken(token, undefined)).toBe(false);
    expect(verifyCsrfToken(undefined, token)).toBe(false);
    expect(verifyCsrfToken(undefined, undefined)).toBe(false);
  });
});
