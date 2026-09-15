import { describe, expect, it } from 'vitest';
import { loadServerEnv } from './env.js';

describe('loadServerEnv', () => {
  it('applies defaults when nothing is set', () => {
    const env = loadServerEnv();
    expect(env.INTERNAL_API_BASE_URL).toBe('http://localhost:4000');
    expect(env.OUTBOUND_ALLOWED_HOSTS).toContain('localhost');
  });

  it('parses a comma-separated allowlist', () => {
    const original = process.env.OUTBOUND_ALLOWED_HOSTS;
    process.env.OUTBOUND_ALLOWED_HOSTS = 'localhost, api.internal';
    try {
      const env = loadServerEnv();
      expect(env.OUTBOUND_ALLOWED_HOSTS).toEqual(['localhost', 'api.internal']);
    } finally {
      if (original === undefined) delete process.env.OUTBOUND_ALLOWED_HOSTS;
      else process.env.OUTBOUND_ALLOWED_HOSTS = original;
    }
  });

  it('rejects a malformed INTERNAL_API_BASE_URL', () => {
    const original = process.env.INTERNAL_API_BASE_URL;
    process.env.INTERNAL_API_BASE_URL = 'not-a-url';
    try {
      expect(() => loadServerEnv()).toThrow();
    } finally {
      if (original === undefined) delete process.env.INTERNAL_API_BASE_URL;
      else process.env.INTERNAL_API_BASE_URL = original;
    }
  });
});
