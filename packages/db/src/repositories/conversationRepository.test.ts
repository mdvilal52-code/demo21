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
  appendMessageToConversation,
  createConversationWithMessage,
  findConversationById,
  findLatestMessageForConversation,
  findMessagesForConversation,
  findMostRecentConversationForCustomer,
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

  describe('conversation continuity', () => {
    it('appends a message to an existing conversation instead of creating a new one', async () => {
      const { conversation } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971501111111',
        content: 'I need a Urus next month',
      });

      const { message } = await appendMessageToConversation(
        prisma,
        TEST_TENANT_ID,
        conversation.id,
        'actually, make it 5 days',
      );

      expect(message.conversationId).toBe(conversation.id);
      const found = await findConversationById(prisma, TEST_TENANT_ID, conversation.id);
      expect(found?.messages).toHaveLength(2);
      expect(found?.messages.map((m) => m.content)).toEqual([
        'I need a Urus next month',
        'actually, make it 5 days',
      ]);
    });

    it('refuses to append to a conversation belonging to a different tenant', async () => {
      const { conversation } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971502222222',
        content: 'hello',
      });

      await expect(
        appendMessageToConversation(prisma, OTHER_TENANT_ID, conversation.id, 'cross-tenant'),
      ).rejects.toThrow();
    });

    it('finds the customer’s most recent conversation on the same channel', async () => {
      const { conversation: first } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971503333333',
        content: 'first message',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const { conversation: second } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971503333333',
        content: 'second, separate conversation',
      });

      const found = await findMostRecentConversationForCustomer(
        prisma,
        TEST_TENANT_ID,
        'WHATSAPP',
        '971503333333',
      );
      expect(found?.id).toBe(second.id);
      expect(found?.id).not.toBe(first.id);
    });

    it('returns messages oldest-first, capped at the requested limit', async () => {
      const { conversation, message: first } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WEB',
        customerRef: 'web-session-transcript',
        content: 'turn 1',
      });
      await appendMessageToConversation(prisma, TEST_TENANT_ID, conversation.id, 'turn 2');
      await appendMessageToConversation(prisma, TEST_TENANT_ID, conversation.id, 'turn 3');

      const all = await findMessagesForConversation(prisma, TEST_TENANT_ID, conversation.id);
      expect(all.map((m) => m.content)).toEqual(['turn 1', 'turn 2', 'turn 3']);
      expect(all[0]?.id).toBe(first.id);

      const capped = await findMessagesForConversation(prisma, TEST_TENANT_ID, conversation.id, {
        limit: 2,
      });
      expect(capped.map((m) => m.content)).toEqual(['turn 2', 'turn 3']);
    });
  });
});
