import { createEligibilityPolicyVersion, createVehicle } from '@ai-concierge/db';
import type { EligibilityPolicyRules } from '@ai-concierge/domain';
import { seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

const DEFAULT_POLICY: EligibilityPolicyRules = {
  minAge: 21,
  minAgeByLuxuryTier: {},
  requiredLicenseTypes: ['UAE', 'GCC', 'IDP'],
  passportRequired: true,
  nationalityRules: { blockedNationalities: [], allowedNationalitiesOnly: [] },
  vehicleRestrictions: {},
  restrictedCities: [],
  driverRequirements: {
    maxAdditionalDrivers: 2,
    additionalDriverMinAge: 21,
    additionalDriversRequireValidLicense: true,
  },
};

function validCustomer(overrides: Record<string, unknown> = {}) {
  return {
    dateOfBirth: '1995-01-01',
    nationality: 'AE',
    licenseType: 'UAE',
    hasValidLicense: true,
    passportProvided: true,
    ...overrides,
  };
}

describe('POST /v1/enquiries/:conversationId/eligibility — security', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp({ RATE_LIMIT_MAX: 1000 });
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
    await createEligibilityPolicyVersion(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      rules: DEFAULT_POLICY,
    });
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
      payload: { channel: 'WEB', customerRef: 'security-test', message },
    });
    return response.json().conversationId as string;
  }

  async function checkEligibility(conversationId: string, body: Record<string, unknown>) {
    return testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/eligibility`,
      payload: body,
    });
  }

  it('rejects a request carrying an unrecognized field attempting to dictate the outcome directly', async () => {
    const conversationId = await createConversation('I want to rent a Lamborghini Urus');

    const response = await checkEligibility(conversationId, {
      customer: validCustomer(),
      status: 'ELIGIBLE',
    });
    expect(response.statusCode).toBe(400);

    // Confirms nothing was persisted from the rejected request.
    const count = await testApp.ctx.prisma.eligibilityDecision.count();
    expect(count).toBe(0);
  });

  it('rejects an attempt to smuggle a policyId/decision override into the body', async () => {
    const conversationId = await createConversation('I want to rent a Lamborghini Urus');

    const response = await checkEligibility(conversationId, {
      customer: validCustomer(),
      policyId: '99999999-9999-9999-9999-999999999999',
      decision: { status: 'ELIGIBLE', ruleResults: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('treats a prototype-pollution-shaped payload as inert (rejected, never a crash)', async () => {
    const conversationId = await createConversation('I want to rent a Lamborghini Urus');

    const response = await checkEligibility(conversationId, {
      customer: validCustomer(),
      __proto__: { polluted: true },
      constructor: { prototype: { polluted: true } },
    });
    expect(response.statusCode).toBe(400);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects a SQL-injection-shaped nationality (fails the ISO code shape check)', async () => {
    const conversationId = await createConversation('I want to rent a Lamborghini Urus');

    const response = await checkEligibility(conversationId, {
      customer: validCustomer({ nationality: "AE'; DROP TABLE tenants; --" }),
    });
    expect(response.statusCode).toBe(400);

    const tenantCount = await testApp.ctx.prisma.tenant.count();
    expect(tenantCount).toBeGreaterThan(0);
  });

  it('rejects an out-of-range/malformed date of birth rather than crashing', async () => {
    const conversationId = await createConversation('I want to rent a Lamborghini Urus');

    const response = await checkEligibility(conversationId, {
      customer: validCustomer({ dateOfBirth: '2099-02-30' }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a future date of birth', async () => {
    const conversationId = await createConversation('I want to rent a Lamborghini Urus');

    const response = await checkEligibility(conversationId, {
      customer: validCustomer({ dateOfBirth: '2099-01-01' }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('never leaks internal error details for a not-found conversation', async () => {
    const response = await checkEligibility('00000000-0000-0000-0000-000000009999', {
      customer: validCustomer(),
    });
    const body = response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(body)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('rejects a request for a conversation belonging to another tenant scope (defense in depth)', async () => {
    const conversationId = await createConversation('I want to rent a Lamborghini Urus');
    await testApp.ctx.prisma.conversation.update({
      where: { id: conversationId },
      data: { tenantId: '00000000-0000-0000-0000-000000000002' },
    });

    const response = await checkEligibility(conversationId, { customer: validCustomer() });
    expect(response.statusCode).toBe(404);
  });

  it('never evaluates a policy or exception belonging to another tenant', async () => {
    await createEligibilityPolicyVersion(testApp.ctx.prisma, {
      tenantId: '00000000-0000-0000-0000-000000000002',
      rules: { ...DEFAULT_POLICY, minAge: 99 },
    });
    const conversationId = await createConversation('I want to rent a Lamborghini Urus');

    const response = await checkEligibility(conversationId, { customer: validCustomer() });
    expect(response.statusCode).toBe(201);
    // The tenant's own minAge (21) applied, not the other tenant's (99).
    expect(response.json().decision.status).toBe('ELIGIBLE');
  });
});
