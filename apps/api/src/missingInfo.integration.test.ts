import { createVehicle } from '@ai-concierge/db';
import { seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

describe('POST /v1/enquiries/:conversationId/missing-info — integration', () => {
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
    await createVehicle(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
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

  async function runDatesLocation(conversationId: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });
    expect(response.statusCode).toBe(201);
  }

  async function runVehicleSelection(conversationId: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/vehicle-selection`,
    });
    expect(response.statusCode).toBe(201);
  }

  async function checkMissingInfo(conversationId: string) {
    return testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/missing-info`,
    });
  }

  it('is COMPLETE once Steps 1-3 have all resolved for the conversation', async () => {
    const conversationId = await createConversation(
      'I want to rent a Lamborghini Urus from 15 to 19 Oct, pickup in Dubai Marina',
    );
    await runDatesLocation(conversationId);
    await runVehicleSelection(conversationId);

    const response = await checkMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);
    const { missingInfo } = response.json();
    expect(missingInfo.status).toBe('COMPLETE');
    expect(missingInfo.missingFields).toEqual([]);
    expect(missingInfo.clarificationPrompt).toBeNull();
    expect(missingInfo.collected.pickupDate).toBe('2026-10-15T06:00:00.000Z');
    expect(missingInfo.collected.vehicle.model).toBe('Urus');
  });

  it('is NEEDS_INFO when Step 3 was never run, naming the vehicle as missing', async () => {
    const conversationId = await createConversation(
      'I want to rent a car from 15 to 19 Oct, pickup in Dubai Marina',
    );
    await runDatesLocation(conversationId);
    // vehicle-selection deliberately not called

    const response = await checkMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);
    const { missingInfo } = response.json();
    expect(missingInfo.status).toBe('NEEDS_INFO');
    expect(missingInfo.missingFields).toEqual([{ field: 'VEHICLE', reason: 'NOT_PROVIDED' }]);
    expect(missingInfo.clarificationPrompt).toContain('vehicle');
    expect(missingInfo.collected.pickupDate).toBe('2026-10-15T06:00:00.000Z');
  });

  it('is NEEDS_INFO with everything missing when no downstream step has been run at all', async () => {
    const conversationId = await createConversation('I want to book a car please');

    const response = await checkMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);
    const { missingInfo } = response.json();
    expect(missingInfo.status).toBe('NEEDS_INFO');
    expect(missingInfo.missingFields).toHaveLength(4);
  });

  it('is EXPIRED when still incomplete more than 24h after the conversation was created', async () => {
    const conversationId = await createConversation('I want to book a car please');
    await testApp.ctx.prisma.conversation.update({
      where: { id: conversationId },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const response = await checkMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);
    const { missingInfo } = response.json();
    expect(missingInfo.status).toBe('EXPIRED');
    expect(missingInfo.clarificationPrompt).toBeNull();
  });

  it('is NOT_APPLICABLE for a non-booking intent', async () => {
    const conversationId = await createConversation('What is your daily rate?');

    const response = await checkMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);
    const { missingInfo } = response.json();
    expect(missingInfo.status).toBe('NOT_APPLICABLE');
    expect(missingInfo.missingFields).toEqual([]);
  });

  it('persists the check and an audit event', async () => {
    const conversationId = await createConversation('I want to book a car please');
    await checkMissingInfo(conversationId);

    const count = await testApp.ctx.prisma.missingInfoCheck.count();
    expect(count).toBe(1);

    const auditRows = await testApp.ctx.prisma.auditEvent.findMany({
      where: { action: 'missing_info.checked' },
    });
    expect(auditRows).toHaveLength(1);
  });

  it('returns 404 for an unknown conversation', async () => {
    const response = await checkMissingInfo('00000000-0000-0000-0000-000000009999');
    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for a malformed conversation id', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries/not-a-uuid/missing-info',
    });
    expect(response.statusCode).toBe(400);
  });
});
