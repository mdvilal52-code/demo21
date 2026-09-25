import { describe, expect, it } from 'vitest';
import { baseEnvSchema, loadEnv } from './env.js';

const validSource = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  OUTBOUND_ALLOWED_HOSTS: 'localhost, api.example.com',
  WEBHOOK_SIGNING_SECRET: 'a-very-long-secret-value',
  DEFAULT_TENANT_ID: '00000000-0000-0000-0000-000000000001',
};

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv(baseEnvSchema, validSource);
    expect(env.NODE_ENV).toBe('test');
    expect(env.OUTBOUND_ALLOWED_HOSTS).toEqual(['localhost', 'api.example.com']);
  });

  it('applies defaults for optional fields', () => {
    const { NODE_ENV: _n, LOG_LEVEL: _l, ...rest } = validSource;
    const env = loadEnv(baseEnvSchema, rest);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('throws a readable error when a required variable is missing', () => {
    const { DATABASE_URL: _omit, ...rest } = validSource;
    expect(() => loadEnv(baseEnvSchema, rest)).toThrowError(/DATABASE_URL/);
  });

  it('throws when a secret is too short', () => {
    expect(() =>
      loadEnv(baseEnvSchema, { ...validSource, WEBHOOK_SIGNING_SECRET: 'short' }),
    ).toThrowError(/WEBHOOK_SIGNING_SECRET/);
  });

  it('trims a trailing newline off WEBHOOK_SIGNING_SECRET (a common dashboard/`.env` paste artifact)', () => {
    const env = loadEnv(baseEnvSchema, {
      ...validSource,
      WEBHOOK_SIGNING_SECRET: 'a-very-long-secret-value\n',
    });
    expect(env.WEBHOOK_SIGNING_SECRET).toBe('a-very-long-secret-value');
  });

  it('rejects a malformed DATABASE_URL instead of passing it through', () => {
    expect(() =>
      loadEnv(baseEnvSchema, { ...validSource, DATABASE_URL: 'not-a-url' }),
    ).toThrowError();
  });
});
