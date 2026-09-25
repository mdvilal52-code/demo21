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
  countRecentSecurityEvents,
  listSecurityEvents,
  recordSecurityEvent,
} from './securityEventRepository.js';

describe('securityEventRepository', () => {
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

  it('records and lists events newest-first, tenant-scoped', async () => {
    await recordSecurityEvent(prisma, {
      tenantId: TEST_TENANT_ID,
      type: 'LOGIN_FAILURE',
      severity: 'WARNING',
      metadata: { attempt: 1 },
    });
    await recordSecurityEvent(prisma, {
      tenantId: TEST_TENANT_ID,
      type: 'LOGIN_SUCCESS',
      severity: 'INFO',
    });
    await recordSecurityEvent(prisma, {
      tenantId: OTHER_TENANT_ID,
      type: 'LOGIN_SUCCESS',
      severity: 'INFO',
    });

    const events = await listSecurityEvents(prisma, { tenantId: TEST_TENANT_ID, limit: 10 });
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('LOGIN_SUCCESS'); // most recent first
    expect(events[1]?.metadata).toEqual({ attempt: 1 });
  });

  it('filters by severity', async () => {
    await recordSecurityEvent(prisma, {
      tenantId: TEST_TENANT_ID,
      type: 'TOKEN_REUSE_DETECTED',
      severity: 'CRITICAL',
    });
    await recordSecurityEvent(prisma, {
      tenantId: TEST_TENANT_ID,
      type: 'LOGIN_SUCCESS',
      severity: 'INFO',
    });

    const critical = await listSecurityEvents(prisma, {
      tenantId: TEST_TENANT_ID,
      severity: 'CRITICAL',
      limit: 10,
    });
    expect(critical).toHaveLength(1);
    expect(critical[0]?.type).toBe('TOKEN_REUSE_DETECTED');
  });

  it('countRecentSecurityEvents only counts events at/after the given time', async () => {
    await recordSecurityEvent(prisma, {
      tenantId: TEST_TENANT_ID,
      type: 'LOGIN_FAILURE',
      severity: 'WARNING',
    });
    const future = new Date(Date.now() + 60_000);
    const count = await countRecentSecurityEvents(prisma, TEST_TENANT_ID, 'LOGIN_FAILURE', future);
    expect(count).toBe(0);

    const past = new Date(Date.now() - 60_000);
    const countPast = await countRecentSecurityEvents(
      prisma,
      TEST_TENANT_ID,
      'LOGIN_FAILURE',
      past,
    );
    expect(countPast).toBe(1);
  });
});
