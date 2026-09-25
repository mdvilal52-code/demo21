import { createVehicle } from '@ai-concierge/db';
import {
  seedTestTenants,
  seedTestUser,
  truncateAllTables,
  TEST_TENANT_ID,
  TEST_USER_PASSWORD,
} from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import { syncCustomerFromJourney } from './services/crmService.js';
import { syncJourneyAfterMissingInfo } from './services/journeyService.js';
import { FakeNotificationProvider } from './test/fakeNotificationProvider.js';

describe('admin read routes (journeys, vehicles, customers, settings)', () => {
  let testApp: TestApp;
  let notificationProvider: FakeNotificationProvider;

  beforeAll(async () => {
    notificationProvider = new FakeNotificationProvider();
    testApp = await buildTestApp(
      { RATE_LIMIT_MAX: 1000, AUTH_RATE_LIMIT_MAX: 1000 },
      { notificationProvider },
    );
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
  });

  async function login(email: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: TEST_USER_PASSWORD },
    });
    return response.json().accessToken as string;
  }

  it('rejects unauthenticated requests to every admin list route', async () => {
    for (const url of ['/v1/journeys', '/v1/vehicles', '/v1/customers', '/v1/settings/providers']) {
      const response = await testApp.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
    }
  });

  it('lists journeys for the authenticated tenant', async () => {
    const conversation = await testApp.ctx.prisma.conversation.create({
      data: { tenantId: TEST_TENANT_ID, channel: 'WHATSAPP', customerRef: '+15550001212' },
    });
    const message = await testApp.ctx.prisma.message.create({
      data: { conversationId: conversation.id, content: 'hi' },
    });
    await syncJourneyAfterMissingInfo(
      { prisma: testApp.ctx.prisma, notificationProvider },
      {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        messageId: message.id,
        resolvedVehicleId: null,
        missingInfoStatus: 'NOT_APPLICABLE',
        requestId: 'req-1',
      },
    );
    await seedTestUser(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
    const token = await login('ops@example.com');

    const response = await testApp.app.inject({
      method: 'GET',
      url: '/v1/journeys',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
  });

  it('lists the fleet', async () => {
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
    await seedTestUser(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
    const token = await login('ops@example.com');

    const response = await testApp.app.inject({
      method: 'GET',
      url: '/v1/vehicles',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].model).toBe('Urus');
  });

  it('lists customers and returns one with its timeline', async () => {
    const conversation = await testApp.ctx.prisma.conversation.create({
      data: { tenantId: TEST_TENANT_ID, channel: 'WHATSAPP', customerRef: '+15550003434' },
    });
    const journey = await testApp.ctx.prisma.journey.create({
      data: { tenantId: TEST_TENANT_ID, conversationId: conversation.id, context: {} },
    });
    const customer = await syncCustomerFromJourney(
      { prisma: testApp.ctx.prisma },
      {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        journeyId: journey.id,
        eventType: 'JOURNEY_STARTED',
        eventSummary: 'Journey started',
        vehicleId: null,
        quoteId: null,
        bookingCompleted: false,
      },
    );
    await seedTestUser(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
    const token = await login('ops@example.com');

    const list = await testApp.app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);

    const detail = await testApp.app.inject({
      method: 'GET',
      url: `/v1/customers/${customer.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().customer.id).toBe(customer.id);
    expect(detail.json().timeline).toHaveLength(1);
  });

  it('reports real provider status, never a fake CONFIGURED', async () => {
    await seedTestUser(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
    const token = await login('ops@example.com');

    const response = await testApp.app.inject({
      method: 'GET',
      url: '/v1/settings/providers',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const status = response.json();
    // buildTestApp defaults every provider to NOT_CONFIGURED unless overridden.
    expect(status.whatsapp).toBe('NOT_CONFIGURED');
    expect(status.email).toBe('NOT_CONFIGURED');
    expect(status.smsNotification).toBe('CONFIGURED'); // this test's own override
  });
});
