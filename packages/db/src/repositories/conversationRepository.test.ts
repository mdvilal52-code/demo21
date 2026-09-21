import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import type { MissingInfoResult } from '@ai-concierge/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendMessageToConversation,
  createConversationWithMessage,
  findConversationById,
  findLatestMessageForConversation,
  findMessagesForConversation,
  findOpenConversationForCustomer,
  markConversationProcessed,
} from './conversationRepository.js';
import { createMissingInfoCheck } from './missingInfoCheckRepository.js';

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

  function fakeMissingInfoResult(status: MissingInfoResult['status']): MissingInfoResult {
    return {
      status,
      collected: {
        pickupDate: null,
        returnDate: null,
        pickupLocation: null,
        dropoffLocation: null,
        vehicle: null,
      },
      missingFields: [],
      clarificationPrompt: status === 'NEEDS_INFO' ? 'When would you like to pick up?' : null,
      expiresAt: '2026-09-21T00:00:00.000Z',
      flags: { promptInjectionDetectedAnywhere: false },
      modelMetadata: { engine: 'missing-info-evaluator-v1', version: '0.1.0', deterministic: true },
    };
  }

  describe('findMessagesForConversation', () => {
    it('returns every message for a conversation, oldest first, scoped to the correct tenant', async () => {
      const { conversation, message: first } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971500000001',
        content: 'I want a Lamborghini Urus',
      });
      const second = await appendMessageToConversation(
        prisma,
        TEST_TENANT_ID,
        conversation.id,
        '15 to 19 Oct',
      );

      const messages = await findMessagesForConversation(prisma, TEST_TENANT_ID, conversation.id);
      expect(messages.map((m) => m.id)).toEqual([first.id, second?.id]);

      const fromOtherTenant = await findMessagesForConversation(
        prisma,
        OTHER_TENANT_ID,
        conversation.id,
      );
      expect(fromOtherTenant).toHaveLength(0);
    });
  });

  describe('appendMessageToConversation', () => {
    it('appends a message to an existing conversation owned by the tenant', async () => {
      const { conversation } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971500000002',
        content: 'hello',
      });

      const appended = await appendMessageToConversation(
        prisma,
        TEST_TENANT_ID,
        conversation.id,
        'follow-up message',
      );

      expect(appended?.conversationId).toBe(conversation.id);
      expect(appended?.content).toBe('follow-up message');

      const messages = await findMessagesForConversation(prisma, TEST_TENANT_ID, conversation.id);
      expect(messages).toHaveLength(2);
    });

    it('returns null instead of appending when the conversation belongs to a different tenant', async () => {
      const { conversation } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971500000003',
        content: 'hello',
      });

      const appended = await appendMessageToConversation(
        prisma,
        OTHER_TENANT_ID,
        conversation.id,
        'should not be created',
      );

      expect(appended).toBeNull();
      const messages = await findMessagesForConversation(prisma, TEST_TENANT_ID, conversation.id);
      expect(messages).toHaveLength(1);
    });

    it('returns null for an unknown conversation id', async () => {
      const appended = await appendMessageToConversation(
        prisma,
        TEST_TENANT_ID,
        '00000000-0000-0000-0000-000000009999',
        'orphan message',
      );
      expect(appended).toBeNull();
    });
  });

  describe('findOpenConversationForCustomer', () => {
    it('returns null when the customer has no conversation yet', async () => {
      const found = await findOpenConversationForCustomer(
        prisma,
        TEST_TENANT_ID,
        'WHATSAPP',
        '971500009999',
      );
      expect(found).toBeNull();
    });

    it('returns the conversation when it has never been through Step 4 yet', async () => {
      const { conversation } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971500000010',
        content: 'hello',
      });

      const found = await findOpenConversationForCustomer(
        prisma,
        TEST_TENANT_ID,
        'WHATSAPP',
        '971500000010',
      );
      expect(found?.id).toBe(conversation.id);
    });

    it.each(['NEEDS_INFO', 'NOT_APPLICABLE'] as const)(
      'returns the conversation when Step 4 last returned %s',
      async (status) => {
        const { conversation, message } = await createConversationWithMessage(prisma, {
          tenantId: TEST_TENANT_ID,
          channel: 'WHATSAPP',
          customerRef: `971500000${status.length}`,
          content: 'I want a car',
        });
        await createMissingInfoCheck(prisma, {
          tenantId: TEST_TENANT_ID,
          messageId: message.id,
          result: fakeMissingInfoResult(status),
        });

        const found = await findOpenConversationForCustomer(
          prisma,
          TEST_TENANT_ID,
          'WHATSAPP',
          `971500000${status.length}`,
        );
        expect(found?.id).toBe(conversation.id);
      },
    );

    it.each(['COMPLETE', 'EXPIRED'] as const)(
      'returns null once Step 4 last returned the terminal status %s',
      async (status) => {
        const { message } = await createConversationWithMessage(prisma, {
          tenantId: TEST_TENANT_ID,
          channel: 'WHATSAPP',
          customerRef: `971500000${status}`,
          content: 'I want a car',
        });
        await createMissingInfoCheck(prisma, {
          tenantId: TEST_TENANT_ID,
          messageId: message.id,
          result: fakeMissingInfoResult(status),
        });

        const found = await findOpenConversationForCustomer(
          prisma,
          TEST_TENANT_ID,
          'WHATSAPP',
          `971500000${status}`,
        );
        expect(found).toBeNull();
      },
    );

    it('starts a new conversation after a prior one completed, for the same customer', async () => {
      const { message: firstMessage } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971500000020',
        content: 'first conversation, completed',
      });
      await createMissingInfoCheck(prisma, {
        tenantId: TEST_TENANT_ID,
        messageId: firstMessage.id,
        result: fakeMissingInfoResult('COMPLETE'),
      });

      // A later, still-open conversation for the same customer.
      const { conversation: secondConversation } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971500000020',
        content: 'second conversation, brand new',
      });

      const found = await findOpenConversationForCustomer(
        prisma,
        TEST_TENANT_ID,
        'WHATSAPP',
        '971500000020',
      );
      expect(found?.id).toBe(secondConversation.id);
    });

    it('never returns a conversation belonging to a different tenant', async () => {
      const { conversation } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971500000030',
        content: 'hello',
      });

      const found = await findOpenConversationForCustomer(
        prisma,
        OTHER_TENANT_ID,
        'WHATSAPP',
        '971500000030',
      );
      expect(found).toBeNull();
      expect(conversation).toBeDefined();
    });

    it('never returns a conversation from a different channel for the same customerRef', async () => {
      await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WEB',
        customerRef: 'shared-ref-1',
        content: 'hello from web',
      });

      const found = await findOpenConversationForCustomer(
        prisma,
        TEST_TENANT_ID,
        'WHATSAPP',
        'shared-ref-1',
      );
      expect(found).toBeNull();
    });
  });
});
