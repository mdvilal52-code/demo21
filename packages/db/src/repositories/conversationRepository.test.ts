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
  createConversationWithMessage,
  findConversationById,
  findLatestMessageForConversation,
  markConversationProcessed,
} from './conversationRepository.js';

describe('conversationRepository', () => {
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

  it('creates a conversation with its first message atomically', async () => {
    const { conversation, message } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: 'web-session-1',
      content: 'I want to rent a car',
    });
    expect(conversation.id).toBeDefined();
    expect(message.conversationId).toBe(conversation.id);
    expect(message.content).toBe('I want to rent a car');
  });

  it('finds a conversation scoped to its own tenant', async () => {
    const { conversation } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: 'web-session-2',
      content: 'hello',
    });
    const found = await findConversationById(prisma, TEST_TENANT_ID, conversation.id);
    expect(found?.id).toBe(conversation.id);
    expect(found?.messages).toHaveLength(1);
  });

  it('never returns a conversation belonging to a different tenant (tenant isolation)', async () => {
    const { conversation } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: 'web-session-3',
      content: 'hello',
    });
    const foundFromOtherTenant = await findConversationById(
      prisma,
      OTHER_TENANT_ID,
      conversation.id,
    );
    expect(foundFromOtherTenant).toBeNull();
  });

  it('marks a conversation processed only within its own tenant', async () => {
    const { conversation } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: 'web-session-4',
      content: 'hello',
    });

    const wrongTenantResult = await markConversationProcessed(
      prisma,
      OTHER_TENANT_ID,
      conversation.id,
    );
    expect(wrongTenantResult.count).toBe(0);

    const correctTenantResult = await markConversationProcessed(
      prisma,
      TEST_TENANT_ID,
      conversation.id,
    );
    expect(correctTenantResult.count).toBe(1);

    const found = await findConversationById(prisma, TEST_TENANT_ID, conversation.id);
    expect(found?.processedAt).not.toBeNull();
  });

  it('finds the latest message for a conversation, scoped to the correct tenant', async () => {
    const { conversation, message } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: 'web-session-5',
      content: 'pickup 15 Oct from Dubai Marina',
    });

    const found = await findLatestMessageForConversation(prisma, TEST_TENANT_ID, conversation.id);
    expect(found?.id).toBe(message.id);

    const foundFromOtherTenant = await findLatestMessageForConversation(
      prisma,
      OTHER_TENANT_ID,
      conversation.id,
    );
    expect(foundFromOtherTenant).toBeNull();
  });

  it('returns null for an unknown conversation id', async () => {
    const found = await findLatestMessageForConversation(
      prisma,
      TEST_TENANT_ID,
      '00000000-0000-0000-0000-000000009999',
    );
    expect(found).toBeNull();
  });
});
