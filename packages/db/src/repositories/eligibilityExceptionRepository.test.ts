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
  createEligibilityException,
  findApplicableEligibilityExceptions,
} from './eligibilityExceptionRepository.js';

describe('eligibilityExceptionRepository', () => {
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

  it('matches an exception scoped to the customer reference', async () => {
    await createEligibilityException(prisma, {
      tenantId: TEST_TENANT_ID,
      type: 'VIP',
      scopeCustomerRef: 'vip-customer-1',
      waivedCategories: ['AGE'],
      riskLevel: 'HIGH',
      reason: 'VIP account',
    });

    const found = await findApplicableEligibilityExceptions(prisma, TEST_TENANT_ID, {
      customerRef: 'vip-customer-1',
      nationality: 'AE',
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('VIP');
  });

  it('matches an exception scoped to a nationality', async () => {
    await createEligibilityException(prisma, {
      tenantId: TEST_TENANT_ID,
      type: 'NATIONALITY_OVERRIDE',
      scopeNationality: 'XX',
      waivedCategories: ['NATIONALITY'],
      riskLevel: 'LOW',
      reason: 'Pre-approved market',
    });

    const found = await findApplicableEligibilityExceptions(prisma, TEST_TENANT_ID, {
      customerRef: 'someone-else',
      nationality: 'XX',
    });
    expect(found).toHaveLength(1);
  });

  it('excludes an inactive exception', async () => {
    const created = await createEligibilityException(prisma, {
      tenantId: TEST_TENANT_ID,
      type: 'VIP',
      scopeCustomerRef: 'vip-customer-1',
      waivedCategories: ['AGE'],
      riskLevel: 'HIGH',
      reason: 'VIP account',
    });
    await prisma.eligibilityException.update({
      where: { id: created.id },
      data: { active: false },
    });

    const found = await findApplicableEligibilityExceptions(prisma, TEST_TENANT_ID, {
      customerRef: 'vip-customer-1',
      nationality: 'AE',
    });
    expect(found).toHaveLength(0);
  });

  it('excludes an expired exception', async () => {
    await createEligibilityException(prisma, {
      tenantId: TEST_TENANT_ID,
      type: 'VIP',
      scopeCustomerRef: 'vip-customer-1',
      waivedCategories: ['AGE'],
      riskLevel: 'HIGH',
      reason: 'VIP account',
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    const found = await findApplicableEligibilityExceptions(prisma, TEST_TENANT_ID, {
      customerRef: 'vip-customer-1',
      nationality: 'AE',
    });
    expect(found).toHaveLength(0);
  });

  it('includes a non-expired exception with a future expiry', async () => {
    await createEligibilityException(prisma, {
      tenantId: TEST_TENANT_ID,
      type: 'VIP',
      scopeCustomerRef: 'vip-customer-1',
      waivedCategories: ['AGE'],
      riskLevel: 'HIGH',
      reason: 'VIP account',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });

    const found = await findApplicableEligibilityExceptions(prisma, TEST_TENANT_ID, {
      customerRef: 'vip-customer-1',
      nationality: 'AE',
    });
    expect(found).toHaveLength(1);
  });

  it('never matches another tenant’s exception (tenant isolation)', async () => {
    await createEligibilityException(prisma, {
      tenantId: OTHER_TENANT_ID,
      type: 'VIP',
      scopeCustomerRef: 'vip-customer-1',
      waivedCategories: ['AGE'],
      riskLevel: 'HIGH',
      reason: 'VIP account',
    });

    const found = await findApplicableEligibilityExceptions(prisma, TEST_TENANT_ID, {
      customerRef: 'vip-customer-1',
      nationality: 'AE',
    });
    expect(found).toHaveLength(0);
  });
});
