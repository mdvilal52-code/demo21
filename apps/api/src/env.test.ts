import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './env.js';

const validSource = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  WEBHOOK_SIGNING_SECRET: 'a-very-long-secret-value',
  DEFAULT_TENANT_ID: '00000000-0000-0000-0000-000000000001',
  JWT_SIGNING_SECRET: 'a-jwt-signing-secret-that-is-at-least-32-bytes-long',
  MFA_ENCRYPTION_KEY: 'hEPpdv0I3rPvipYa674EeHgK51Zb+BwciFTcTSAch60=',
};

describe('loadApiEnv', () => {
  it('defaults API_PORT to 4000 when neither API_PORT nor PORT is set', () => {
    const env = loadApiEnv(validSource);
    expect(env.API_PORT).toBe(4000);
  });

  it('adopts the platform-standard PORT variable when API_PORT is not set', () => {
    const env = loadApiEnv({ ...validSource, PORT: '10000' });
    expect(env.API_PORT).toBe(10000);
  });

  it('prefers an explicitly set API_PORT over PORT', () => {
    const env = loadApiEnv({ ...validSource, API_PORT: '5000', PORT: '10000' });
    expect(env.API_PORT).toBe(5000);
  });

  it('rejects an MFA_ENCRYPTION_KEY that is not exactly 32 bytes decoded', () => {
    expect(() =>
      loadApiEnv({
        ...validSource,
        MFA_ENCRYPTION_KEY: Buffer.from('too-short').toString('base64'),
      }),
    ).toThrow(/32 bytes/);
  });

  it('rejects a JWT_SIGNING_SECRET shorter than 32 characters', () => {
    expect(() => loadApiEnv({ ...validSource, JWT_SIGNING_SECRET: 'short' })).toThrow();
  });
});
