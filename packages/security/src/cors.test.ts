import { describe, expect, it } from 'vitest';
import { buildCorsOriginChecker, isOriginAllowed } from './cors.js';

describe('isOriginAllowed', () => {
  it('allows an exact match', () => {
    expect(isOriginAllowed('http://localhost:3000', ['http://localhost:3000'])).toBe(true);
  });

  it('rejects an origin not on the list', () => {
    expect(isOriginAllowed('http://evil.example.com', ['http://localhost:3000'])).toBe(false);
  });

  it('rejects undefined origin', () => {
    expect(isOriginAllowed(undefined, ['http://localhost:3000'])).toBe(false);
  });

  it('does not allow substring matches', () => {
    expect(isOriginAllowed('http://localhost:3000.evil.com', ['http://localhost:3000'])).toBe(
      false,
    );
  });
});

describe('buildCorsOriginChecker', () => {
  it('allows requests with no Origin header', () => {
    const checker = buildCorsOriginChecker(['http://localhost:3000']);
    checker(undefined, (err, allow) => {
      expect(err).toBeNull();
      expect(allow).toBe(true);
    });
  });

  it('allows an allowlisted origin', () => {
    const checker = buildCorsOriginChecker(['http://localhost:3000']);
    checker('http://localhost:3000', (err, allow) => {
      expect(err).toBeNull();
      expect(allow).toBe(true);
    });
  });

  it('rejects a non-allowlisted origin with an error', () => {
    const checker = buildCorsOriginChecker(['http://localhost:3000']);
    checker('http://attacker.example', (err, allow) => {
      expect(err).toBeInstanceOf(Error);
      expect(allow).toBe(false);
    });
  });
});
