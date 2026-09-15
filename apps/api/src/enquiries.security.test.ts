import { MALICIOUS_PAYLOADS, seedTestTenants, truncateAllTables } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

describe('AI Concierge API — security', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    // A generous limit here: @fastify/rate-limit tracks a single counter per
    // IP across the whole app, and every `it` in this file shares one app
    // instance. The dedicated rate-limit test below uses its own app with a
    // deliberately low limit instead of tripping this shared counter.
    testApp = await buildTestApp({ RATE_LIMIT_MAX: 1000 });
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
  });

  it('stores a SQL injection payload as inert text and returns 201, not a server error', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: {
        channel: 'WEB',
        customerRef: 'sqli-test',
        message: `I want to rent a car ${MALICIOUS_PAYLOADS.sqlInjection}`,
      },
    });
    expect(response.statusCode).toBe(201);
    const count = await testApp.ctx.prisma.conversation.count();
    expect(count).toBe(1);
  });

  it('stores an HTML/script payload as literal text in the JSON response, never executed', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: { channel: 'WEB', customerRef: 'xss-test', message: MALICIOUS_PAYLOADS.htmlXss },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toContain('application/json');

    const stored = await testApp.ctx.prisma.message.findFirst({ where: {} });
    expect(stored?.content).toBe(MALICIOUS_PAYLOADS.htmlXss);
  });

  it('flags a prompt-injection payload in the recognized intent', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: {
        channel: 'WEB',
        customerRef: 'injection-test',
        message: MALICIOUS_PAYLOADS.promptInjection,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().intent.flags.promptInjectionDetected).toBe(true);
  });

  it('rejects a request body over the configured size limit with 413', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: {
        channel: 'WEB',
        customerRef: 'oversized-test',
        message: 'a'.repeat(200_000),
      },
    });
    expect(response.statusCode).toBe(413);
  });

  it('rejects a disallowed CORS origin', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://attacker.example' },
    });
    // helmet/cors reject by not echoing the origin back; the request itself
    // still completes (fastify/cors does not abort simple GETs), but no
    // Access-Control-Allow-Origin header is granted for the disallowed origin.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows an allowlisted CORS origin', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('sends secure headers on every response', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('enforces the configured rate limit', async () => {
    const limitedApp = await buildTestApp({ RATE_LIMIT_MAX: 3, RATE_LIMIT_WINDOW_MS: 60_000 });
    try {
      const requests = Array.from({ length: 6 }, () =>
        limitedApp.app.inject({ method: 'GET', url: '/live' }),
      );
      const responses = await Promise.all(requests);
      const tooManyRequests = responses.filter((response) => response.statusCode === 429);
      expect(tooManyRequests.length).toBeGreaterThan(0);
    } finally {
      await limitedApp.close();
    }
  });

  it('never leaks internal error details to the client', async () => {
    // an oversized path parameter forces a validation error path; the
    // response must carry only the stable error envelope, never a stack trace.
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/v1/enquiries/not-a-valid-uuid-at-all',
    });
    const body = response.json();
    expect(body.error.code).toBeDefined();
    expect(JSON.stringify(body)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });
});
