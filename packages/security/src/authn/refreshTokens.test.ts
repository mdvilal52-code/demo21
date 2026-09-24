import { describe, expect, it } from 'vitest';
import { hashRefreshToken, issueRefreshToken, rotateRefreshToken } from './refreshTokens.js';

describe('refresh tokens', () => {
  it('issues a new token with a fresh family id', () => {
    const a = issueRefreshToken();
    const b = issueRefreshToken();
    expect(a.familyId).not.toBe(b.familyId);
    expect(a.token).not.toBe(b.token);
  });

  it('stores only the hash, never the raw token, in tokenHash', () => {
    const { token, tokenHash } = issueRefreshToken();
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toBe(hashRefreshToken(token));
  });

  it('rotation keeps the same family id but issues a new token', () => {
    const first = issueRefreshToken();
    const rotated = rotateRefreshToken(first.familyId);
    expect(rotated.familyId).toBe(first.familyId);
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.tokenHash).not.toBe(first.tokenHash);
  });

  it('sets a future expiry', () => {
    const { expiresAt } = issueRefreshToken();
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('hashRefreshToken is deterministic', () => {
    expect(hashRefreshToken('abc')).toBe(hashRefreshToken('abc'));
  });
});
