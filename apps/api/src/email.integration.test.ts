import { createHmac } from 'node:crypto';
import { createVehicle } from '@ai-concierge/db';
import { seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import { FakeEmailProvider } from './test/fakeEmailProvider.js';

const SIGNING_KEY = 'test-mailgun-signing-key-0123456789';

function mailgunPayload(overrides: Record<string, string> = {}): URLSearchParams {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = overrides.token ?? `token-${Math.random().toString(36).slice(2)}`;
  const signature = createHmac('sha256', SIGNING_KEY).update(`${timestamp}${token}`).digest('hex');
  const fields: Record<string, string> = {
    sender: 'customer@example.com',
    recipient: 'concierge@fleet.example.com',
    subject: 'Booking enquiry',
    'body-plain': 'I want to rent a Lamborghini Urus 15-19 Oct, Dubai',
    'Message-Id': `<${token}@mail.example.com>`,
    timestamp,
    token,
    signature,
    ...overrides,
  };
  return new URLSearchParams(fields);
}

describe('Email webhook — integration', () => {
  let testApp: TestApp;
  let fakeProvider: FakeEmailProvider;

  beforeAll(async () => {
    fakeProvider = new FakeEmailProvider();
    testApp = await buildTestApp(
      { MAILGUN_WEBHOOK_SIGNING_KEY: SIGNING_KEY },
      { emailProvider: fakeProvider },
    );
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
    fakeProvider.sent.length = 0;
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

  async function send(overrides: Record<string, string> = {}) {
    const body = mailgunPayload(overrides);
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: body.toString(),
    });
    return {
      status: response.statusCode,
      reply: fakeProvider.sent.at(-1) ?? null,
    };
  }

  it('runs Steps 1-4 automatically for a real inbound email and replies with the deterministic result', async () => {
    const result = await send({
      'body-plain':
        'I want to rent a Lamborghini Urus 15-19 Oct, Dubai. My name is Ahmed, pickup at Dubai International Airport.',
    });
    expect(result.status).toBe(200);
    expect(result.reply?.to).toBe('customer@example.com');
    expect(result.reply?.subject).toMatch(/^Re:/);
    expect(result.reply?.body).toBeTruthy();

    const journey = await testApp.ctx.prisma.journey.findFirst({
      where: { conversation: { customerRef: 'customer@example.com' } },
    });
    expect(journey).not.toBeNull();
    expect(journey?.state).toBe('ELIGIBILITY_CHECK');

    const customer = await testApp.ctx.prisma.customer.findFirst({
      where: { customerRef: 'customer@example.com', channel: 'EMAIL' },
    });
    expect(customer).not.toBeNull();
  });

  it('is idempotent for a redelivered Mailgun token: no reprocessing, no second reply', async () => {
    const token = 'fixed-redelivery-token';
    const first = await send({ token });
    expect(first.status).toBe(200);
    expect(fakeProvider.sent).toHaveLength(1);

    const second = await send({ token });
    expect(second.status).toBe(200);
    expect(fakeProvider.sent).toHaveLength(1); // no second send
  });

  it('reports NOT_CONFIGURED (never processes) when MAILGUN_WEBHOOK_SIGNING_KEY is unset', async () => {
    const unconfiguredApp = await buildTestApp({ MAILGUN_WEBHOOK_SIGNING_KEY: undefined });
    try {
      const body = mailgunPayload();
      const response = await unconfiguredApp.app.inject({
        method: 'POST',
        url: '/webhooks/email',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: body.toString(),
      });
      expect(response.statusCode).toBe(501);
    } finally {
      await unconfiguredApp.close();
    }
  });
});
