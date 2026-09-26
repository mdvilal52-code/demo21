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
import {
  findEligibilityIntake,
  markEligibilityIntakeAsked,
  upsertEligibilityIntake,
} from './eligibilityIntakeRepository.js';
import {
  createOutboundMessage,
  findOutboundMessagesForConversation,
} from './outboundMessageRepository.js';

describe('eligibilityIntakeRepository / outboundMessageRepository', () => {
  let prisma: PrismaClient;
  let conversationId: string;

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
    const created = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '+971500000001',
      content: 'I want the Urus',
    });
    conversationId = created.conversation.id;
  });

  it('returns null when nothing has been collected yet', async () => {
    expect(await findEligibilityIntake(prisma, TEST_TENANT_ID, conversationId)).toBeNull();
  });

  it('creates the row on first upsert and merges later patches without resetting other fields', async () => {
    await upsertEligibilityIntake(prisma, TEST_TENANT_ID, conversationId, {
      nationality: 'IN',
      passportProvided: true,
    });
    const merged = await upsertEligibilityIntake(prisma, TEST_TENANT_ID, conversationId, {
      licenseType: 'UAE',
      hasValidLicense: true,
    });
    expect(merged).toMatchObject({
      nationality: 'IN',
      passportProvided: true,
      licenseType: 'UAE',
      hasValidLicense: true,
      dateOfBirthEnc: null,
    });
  });

  it('records askedAt once and never moves it', async () => {
    const first = new Date('2026-09-26T10:00:00.000Z');
    const later = new Date('2026-09-26T11:00:00.000Z');
    await markEligibilityIntakeAsked(prisma, TEST_TENANT_ID, conversationId, first);
    await markEligibilityIntakeAsked(prisma, TEST_TENANT_ID, conversationId, later);
    const stored = await findEligibilityIntake(prisma, TEST_TENANT_ID, conversationId);
    expect(stored?.askedAt?.toISOString()).toBe(first.toISOString());
  });

  it('does not clear askedAt when details are patched afterwards', async () => {
    const asked = new Date('2026-09-26T10:00:00.000Z');
    await markEligibilityIntakeAsked(prisma, TEST_TENANT_ID, conversationId, asked);
    await upsertEligibilityIntake(prisma, TEST_TENANT_ID, conversationId, { nationality: 'GB' });
    const stored = await findEligibilityIntake(prisma, TEST_TENANT_ID, conversationId);
    expect(stored?.askedAt?.toISOString()).toBe(asked.toISOString());
    expect(stored?.nationality).toBe('GB');
  });

  it('is tenant-scoped on read', async () => {
    await upsertEligibilityIntake(prisma, TEST_TENANT_ID, conversationId, { nationality: 'IN' });
    expect(await findEligibilityIntake(prisma, OTHER_TENANT_ID, conversationId)).toBeNull();
  });

  it('stores outbound messages and returns the most recent ones oldest-first', async () => {
    for (const content of ['one', 'two', 'three']) {
      await createOutboundMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        conversationId,
        content,
        source: 'TEMPLATE',
        stage: 'COLLECTING_MISSING_INFO',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const all = await findOutboundMessagesForConversation(prisma, TEST_TENANT_ID, conversationId);
    expect(all.map((row) => row.content)).toEqual(['one', 'two', 'three']);
    const lastTwo = await findOutboundMessagesForConversation(
      prisma,
      TEST_TENANT_ID,
      conversationId,
      2,
    );
    expect(lastTwo.map((row) => row.content)).toEqual(['two', 'three']);
    expect(
      await findOutboundMessagesForConversation(prisma, OTHER_TENANT_ID, conversationId),
    ).toEqual([]);
  });
});

describe('row level security on the intake tables', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(['eligibility_intakes', 'outbound_messages'])(
    '%s enforces tenant isolation even for the table owner, and grants the API role no DELETE',
    async (table) => {
      const [flags] = await prisma.$queryRawUnsafe<
        Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = '${table}'`);
      expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

      const policies = await prisma.$queryRawUnsafe<Array<{ policyname: string; qual: string }>>(
        `SELECT policyname, qual FROM pg_policies WHERE tablename = '${table}'`,
      );
      expect(policies).toHaveLength(1);
      expect(policies[0]!.policyname).toBe('tenant_isolation');
      expect(policies[0]!.qual).toContain("current_setting('app.tenant_id'");

      const privileges = await prisma.$queryRawUnsafe<Array<{ privilege_type: string }>>(
        `SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'ai_concierge_api' AND table_name = '${table}'`,
      );
      expect(privileges.map((row) => row.privilege_type).sort()).toEqual([
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
    },
  );
});
