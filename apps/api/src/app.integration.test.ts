import { seedTestTenants, truncateAllTables } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

describe('AI Concierge API — integration', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
  });

  describe('health', () => {
    it('GET /health returns ok', async () => {
      const response = await testApp.app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok', observability: 'NOT_CONFIGURED' });
    });

    it('GET /live returns alive with an uptime', async () => {
      const response = await testApp.app.inject({ method: 'GET', url: '/live' });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('alive');
    });

    it('GET /ready reports both dependencies up', async () => {
      const response = await testApp.app.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: 'ready',
        dependencies: { database: 'up', redis: 'up' },
      });
    });
  });

  describe('POST /v1/enquiries', () => {
    it('creates a conversation and returns the recognized intent', async () => {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/v1/enquiries',
        payload: {
          channel: 'WEB',
          customerRef: 'web-session-1',
          message: 'I want to rent a Lamborghini in Dubai from 15 to 19 October',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.conversationId).toBeDefined();
      expect(body.messageId).toBeDefined();
      expect(body.intent.intentType).toBe('BOOKING_REQUEST');
    });

    it('rejects an empty message with 400', async () => {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/v1/enquiries',
        payload: { channel: 'WEB', customerRef: 'web-session-1', message: '' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an invalid channel with 400', async () => {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/v1/enquiries',
        payload: { channel: 'CARRIER_PIGEON', customerRef: 'x', message: 'hello' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('replays the same response for a repeated Idempotency-Key without duplicating data', async () => {
      const payload = {
        channel: 'WEB' as const,
        customerRef: 'web-session-2',
        message: 'I need a car',
      };
      const first = await testApp.app.inject({
        method: 'POST',
        url: '/v1/enquiries',
        headers: { 'idempotency-key': 'idem-key-1' },
        payload,
      });
      const second = await testApp.app.inject({
        method: 'POST',
        url: '/v1/enquiries',
        headers: { 'idempotency-key': 'idem-key-1' },
        payload,
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(first.json().conversationId).toBe(second.json().conversationId);

      const count = await testApp.ctx.prisma.conversation.count();
      expect(count).toBe(1);
    });
  });

  describe('GET /v1/enquiries/:conversationId', () => {
    it('returns the conversation that was created', async () => {
      const created = await testApp.app.inject({
        method: 'POST',
        url: '/v1/enquiries',
        payload: { channel: 'WEB', customerRef: 'web-session-3', message: 'How much for an SUV?' },
      });
      const { conversationId } = created.json();

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/v1/enquiries/${conversationId}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.conversationId).toBe(conversationId);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].intents).toHaveLength(1);
    });

    it('returns 404 for an unknown conversation id', async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/v1/enquiries/00000000-0000-0000-0000-000000009999',
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 400 for a malformed conversation id', async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/v1/enquiries/not-a-uuid',
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
