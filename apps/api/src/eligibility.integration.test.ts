import {
  createEligibilityException,
  createEligibilityPolicyVersion,
  createVehicle,
} from '@ai-concierge/db';
import type { EligibilityPolicyRules } from '@ai-concierge/domain';
import { seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

const DEFAULT_POLICY: EligibilityPolicyRules = {
  minAge: 21,
  minAgeByLuxuryTier: { ULTRA_LUXURY: 25 },
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
    dateOfBirth: '1995-01-01', // well over 25 as of the fixed pickup date used below
    nationality: 'AE',
    licenseType: 'UAE',
    hasValidLicense: true,
    passportProvided: true,
    ...overrides,
  };
}

describe('POST /v1/enquiries/:conversationId/eligibility — integration', () => {
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

  async function seedPolicy(rules: EligibilityPolicyRules = DEFAULT_POLICY) {
    return createEligibilityPolicyVersion(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, rules });
  }

  async function seedFleet() {
    return createVehicle(testApp.ctx.prisma, {
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
  }

  async function createConversation(message: string, customerRef = 'web-session-1') {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: { channel: 'WEB', customerRef, message },
    });
    expect(response.statusCode).toBe(201);
    return response.json().conversationId as string;
  }

  async function runVehicleSelection(conversationId: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/vehicle-selection`,
    });
    expect(response.statusCode).toBe(201);
  }

  async function runDatesLocation(conversationId: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });
    expect(response.statusCode).toBe(201);
  }

  async function checkEligibility(conversationId: string, body: Record<string, unknown>) {
    return testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/eligibility`,
      payload: body,
    });
  }

  async function fullBookingConversation() {
    await seedFleet();
    const conversationId = await createConversation(
      'I want to rent a Lamborghini Urus from 15 to 19 Oct, pickup in Dubai Marina',
    );
    await Promise.all([runVehicleSelection(conversationId), runDatesLocation(conversationId)]);
    return conversationId;
  }

  it('is ELIGIBLE for a valid customer against a resolved vehicle/dates/location', async () => {
    await seedPolicy();
    const conversationId = await fullBookingConversation();

    const response = await checkEligibility(conversationId, { customer: validCustomer() });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.conversationId).toBe(conversationId);
    expect(body.decision.status).toBe('ELIGIBLE');
    expect(body.decision.ruleResults).toHaveLength(7);
  });

  it('is INELIGIBLE for an underage customer', async () => {
    await seedPolicy();
    const conversationId = await fullBookingConversation();

    const response = await checkEligibility(conversationId, {
      customer: validCustomer({ dateOfBirth: '2008-01-01' }),
    });
    expect(response.statusCode).toBe(201);
    const { decision } = response.json();
    expect(decision.status).toBe('INELIGIBLE');
    expect(decision.ruleResults).toContainEqual(
      expect.objectContaining({ category: 'AGE', outcome: 'FAIL' }),
    );
  });

  it('is INELIGIBLE when no valid license was declared (missing license)', async () => {
    await seedPolicy();
    const conversationId = await fullBookingConversation();

    const response = await checkEligibility(conversationId, {
      customer: validCustomer({ hasValidLicense: false }),
    });
    expect(response.statusCode).toBe(201);
    const { decision } = response.json();
    expect(decision.status).toBe('INELIGIBLE');
    expect(decision.ruleResults).toContainEqual(
      expect.objectContaining({ category: 'LICENSE', outcome: 'FAIL' }),
    );
  });

  it('is INELIGIBLE for a license type the tenant does not accept (invalid license)', async () => {
    await seedPolicy();
    const conversationId = await fullBookingConversation();

    const response = await checkEligibility(conversationId, {
      customer: validCustomer({ licenseType: 'FOREIGN' }),
    });
    expect(response.statusCode).toBe(201);
    const { decision } = response.json();
    expect(decision.status).toBe('INELIGIBLE');
  });

  it('auto-applies a low-risk nationality exception and becomes ELIGIBLE', async () => {
    await seedPolicy({
      ...DEFAULT_POLICY,
      nationalityRules: { blockedNationalities: ['XX'], allowedNationalitiesOnly: [] },
    });
    await createEligibilityException(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      type: 'NATIONALITY_OVERRIDE',
      scopeNationality: 'XX',
      waivedCategories: ['NATIONALITY'],
      riskLevel: 'LOW',
      reason: 'Pre-approved market',
    });
    const conversationId = await fullBookingConversation();

    const response = await checkEligibility(conversationId, {
      customer: validCustomer({ nationality: 'XX' }),
    });
    expect(response.statusCode).toBe(201);
    const { decision } = response.json();
    expect(decision.status).toBe('ELIGIBLE');
    expect(decision.exceptionsApplied).toHaveLength(1);
    expect(decision.exceptionsApplied[0].autoApplied).toBe(true);
  });

  it('a high-risk VIP exception never auto-applies — NEEDS_HUMAN_REVIEW instead', async () => {
    await seedPolicy();
    await createEligibilityException(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      type: 'VIP',
      scopeCustomerRef: 'web-session-1',
      waivedCategories: ['AGE'],
      riskLevel: 'HIGH',
      reason: 'VIP customer',
    });
    const conversationId = await fullBookingConversation();

    const response = await checkEligibility(conversationId, {
      customer: validCustomer({ dateOfBirth: '2008-01-01' }),
    });
    expect(response.statusCode).toBe(201);
    const { decision } = response.json();
    expect(decision.status).toBe('NEEDS_HUMAN_REVIEW');
    expect(decision.exceptionsApplied[0].autoApplied).toBe(false);
  });

  it('fails safe to NEEDS_HUMAN_REVIEW when the tenant policy has an internal conflict', async () => {
    await seedPolicy({
      ...DEFAULT_POLICY,
      nationalityRules: { blockedNationalities: ['XX'], allowedNationalitiesOnly: ['XX', 'AE'] },
    });
    const conversationId = await fullBookingConversation();

    const response = await checkEligibility(conversationId, { customer: validCustomer() });
    expect(response.statusCode).toBe(201);
    const { decision } = response.json();
    expect(decision.status).toBe('NEEDS_HUMAN_REVIEW');
    expect(decision.flags.policyConflictDetected).toBe(true);
  });

  it('is 501 NOT_CONFIGURED when the tenant has no eligibility policy at all', async () => {
    const conversationId = await createConversation('I want to rent a car');

    const response = await checkEligibility(conversationId, { customer: validCustomer() });
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe('NOT_CONFIGURED');
  });

  it('persists the decision and an audit event', async () => {
    await seedPolicy();
    const conversationId = await fullBookingConversation();
    await checkEligibility(conversationId, { customer: validCustomer() });

    const count = await testApp.ctx.prisma.eligibilityDecision.count();
    expect(count).toBe(1);

    const auditRows = await testApp.ctx.prisma.auditEvent.findMany({
      where: { action: 'eligibility.decided' },
    });
    expect(auditRows).toHaveLength(1);
  });

  it('returns 404 for an unknown conversation', async () => {
    await seedPolicy();
    const response = await checkEligibility('00000000-0000-0000-0000-000000009999', {
      customer: validCustomer(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for a malformed conversation id', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries/not-a-uuid/eligibility',
      payload: { customer: validCustomer() },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when the customer field is missing', async () => {
    await seedPolicy();
    const conversationId = await fullBookingConversation();
    const response = await checkEligibility(conversationId, {});
    expect(response.statusCode).toBe(400);
  });
});
