import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaAuditWriter } from './auditRepository.js';

describe('PrismaAuditWriter', () => {
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

  it('records an audit event with field-level before/after diffs', async () => {
    const writer = new PrismaAuditWriter(prisma);
    await writer.record({
      tenantId: TEST_TENANT_ID,
      actor: 'system',
      action: 'conversation.created',
      entityType: 'Conversation',
      entityId: 'c-1',
      after: { channel: 'WEB' },
      requestId: 'req-1',
    });

    const rows = await prisma.auditEvent.findMany({ where: { tenantId: TEST_TENANT_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('conversation.created');
    expect(rows[0]?.after).toEqual({ channel: 'WEB' });
  });

  it('does not store a raw entity dump, only what the caller passes explicitly', async () => {
    const writer = new PrismaAuditWriter(prisma);
    await writer.record({
      tenantId: TEST_TENANT_ID,
      actor: 'system',
      action: 'intent.recognized',
      entityType: 'IntentRecord',
      entityId: 'i-1',
    });
    const [row] = await prisma.auditEvent.findMany({ where: { tenantId: TEST_TENANT_ID } });
    expect(row?.before).toBeNull();
    expect(row?.after).toBeNull();
  });
});
