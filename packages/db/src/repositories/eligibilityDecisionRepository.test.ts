import type { EligibilityDecisionResult, EligibilityPolicyRules } from '@ai-concierge/domain';
import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConversationWithMessage } from './conversationRepository.js';
import { createEligibilityPolicyVersion } from './eligibilityPolicyRepository.js';
import {
  createEligibilityDecision,
  findLatestEligibilityDecisionForMessage,
} from './eligibilityDecisionRepository.js';

const BASE_RULES: EligibilityPolicyRules = {
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

describe('eligibilityDecisionRepository', () => {
  let prisma: PrismaClient;
  let messageId: string;
  let policyId: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedTestTenants(prisma);
    const { message } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: 'session-1',
      content: 'I want to rent a Lamborghini Urus',
    });
    messageId = message.id;
    const policy = await createEligibilityPolicyVersion(prisma, {
      tenantId: TEST_TENANT_ID,
      rules: BASE_RULES,
    });
    policyId = policy.id;
  });

  function buildResult(
    overrides: Partial<EligibilityDecisionResult> = {},
  ): EligibilityDecisionResult {
    return {
      status: 'ELIGIBLE',
      ruleResults: [{ ruleId: 'age-minimum', category: 'AGE', outcome: 'PASS', message: 'ok' }],
      exceptionsApplied: [],
      policyConflicts: [],
      reason: 'Eligible. All checks passed.',
      policyId,
      policyVersion: 1,
      flags: { policyConflictDetected: false },
      modelMetadata: { engine: 'eligibility-engine-v1', version: '0.1.0', deterministic: true },
      ...overrides,
    };
  }

  it('persists a decision', async () => {
    const result = buildResult();
    const row = await createEligibilityDecision(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      result,
    });
    expect(row.status).toBe('ELIGIBLE');
    expect(row.policyId).toBe(policyId);
  });

  it('finds the latest decision for a message, scoped to the correct tenant', async () => {
    await createEligibilityDecision(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      result: buildResult({ status: 'INELIGIBLE', reason: 'Ineligible: first attempt.' }),
    });
    await createEligibilityDecision(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      result: buildResult({ status: 'ELIGIBLE', reason: 'Eligible. All checks passed.' }),
    });

    const found = await findLatestEligibilityDecisionForMessage(prisma, TEST_TENANT_ID, messageId);
    expect(found?.status).toBe('ELIGIBLE');

    const foundFromOtherTenant = await findLatestEligibilityDecisionForMessage(
      prisma,
      OTHER_TENANT_ID,
      messageId,
    );
    expect(foundFromOtherTenant).toBeNull();
  });
});
