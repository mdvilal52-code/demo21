import { seedTestTenants, truncateAllTables } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

describe('POST /v1/enquiries/:conversationId/dates-location — integration', () => {
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

  async function createConversation(message: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: { channel: 'WEB', customerRef: 'web-session-1', message },
    });
    expect(response.statusCode).toBe(201);
    return response.json().conversationId as string;
  }

  it('extracts dates and location from a conversation created via Phase 1', async () => {
    const conversationId = await createConversation(
      'I want to rent a car from 15 to 19 Oct, pickup in Dubai Marina',
    );

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.conversationId).toBe(conversationId);
    expect(body.extraction.pickupDate).toBe('2026-10-15T06:00:00.000Z');
    expect(body.extraction.returnDate).toBe('2026-10-19T06:00:00.000Z');
    expect(body.extraction.pickupLocation.city).toBe('Dubai');
    expect(body.extraction.validationErrors).toEqual([]);
  });

  it('persists the extraction so it can be retrieved again from the DB', async () => {
    const conversationId = await createConversation('pickup 15 Oct in Dubai Marina');
    await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });

    const count = await testApp.ctx.prisma.dateLocationExtraction.count();
    expect(count).toBe(1);

    const auditRows = await testApp.ctx.prisma.auditEvent.findMany({
      where: { action: 'dates_location.extracted' },
    });
    expect(auditRows).toHaveLength(1);
  });

  it('surfaces validation errors for a return-before-pickup message', async () => {
    const conversationId = await createConversation('pickup 20 Oct return 15 Oct, Dubai Marina');

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().extraction.validationErrors).toContainEqual(
      expect.objectContaining({ code: 'RETURN_BEFORE_OR_EQUAL_PICKUP' }),
    );
  });

  it('returns 404 for an unknown conversation', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries/00000000-0000-0000-0000-000000009999/dates-location',
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for a malformed conversation id', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries/not-a-uuid/dates-location',
    });
    expect(response.statusCode).toBe(400);
  });
});
