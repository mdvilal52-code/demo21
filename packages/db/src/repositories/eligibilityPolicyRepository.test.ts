import type { EligibilityPolicyRules } from '@ai-concierge/domain';
import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createEligibilityPolicyVersion,
  findActiveEligibilityPolicy,
} from './eligibilityPolicyRepository.js';

const BASE_RULES: EligibilityPolicyRules = {
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

describe('eligibilityPolicyRepository', () => {
  let prisma: PrismaClient;

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
  });

  it('returns null when the tenant has no policy configured', async () => {
    const policy = await findActiveEligibilityPolicy(prisma, TEST_TENANT_ID);
    expect(policy).toBeNull();
  });

  it('creates version 1 as the active policy', async () => {
    const created = await createEligibilityPolicyVersion(prisma, {
      tenantId: TEST_TENANT_ID,
      rules: BASE_RULES,
    });
    expect(created.version).toBe(1);
    expect(created.active).toBe(true);
    expect(created.rules).toEqual(BASE_RULES);

    const active = await findActiveEligibilityPolicy(prisma, TEST_TENANT_ID);
    expect(active?.id).toBe(created.id);
  });

  it('creating a new version deactivates every previous version', async () => {
    const v1 = await createEligibilityPolicyVersion(prisma, {
      tenantId: TEST_TENANT_ID,
      rules: BASE_RULES,
    });
    const v2 = await createEligibilityPolicyVersion(prisma, {
      tenantId: TEST_TENANT_ID,
      rules: { ...BASE_RULES, minAge: 23 },
    });

    expect(v2.version).toBe(2);
    const active = await findActiveEligibilityPolicy(prisma, TEST_TENANT_ID);
    expect(active?.id).toBe(v2.id);
    expect(active?.rules.minAge).toBe(23);

    const v1Row = await prisma.eligibilityPolicy.findUniqueOrThrow({ where: { id: v1.id } });
    expect(v1Row.active).toBe(false);
  });

  it('never returns another tenant’s policy (tenant isolation)', async () => {
    await createEligibilityPolicyVersion(prisma, { tenantId: OTHER_TENANT_ID, rules: BASE_RULES });
    const active = await findActiveEligibilityPolicy(prisma, TEST_TENANT_ID);
    expect(active).toBeNull();
  });
});
