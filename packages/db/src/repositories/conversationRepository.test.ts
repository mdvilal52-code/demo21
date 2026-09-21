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
  findLatestConversationForCustomer,
  findLatestMessageForConversation,
  markConversationProcessed,
  updateConversationStage,
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

  it('a new conversation starts in the NEW stage', async () => {
    const { conversation } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000010',
      content: 'Hiii',
    });
    expect(conversation.stage).toBe('NEW');
  });

  it("finds the customer's most recently started conversation on that channel", async () => {
    const { conversation: older } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000011',
      content: 'Hiii',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { conversation: newer } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000011',
      content: 'Hello again',
    });

    const found = await findLatestConversationForCustomer(
      prisma,
      TEST_TENANT_ID,
      'WHATSAPP',
      '971500000011',
    );
    expect(found?.id).toBe(newer.id);
    expect(found?.id).not.toBe(older.id);
  });

  it('returns null when the customer has no conversation yet, and never crosses tenants or channels', async () => {
    const noneYet = await findLatestConversationForCustomer(
      prisma,
      TEST_TENANT_ID,
      'WHATSAPP',
      '971500000012',
    );
    expect(noneYet).toBeNull();

    const { conversation } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000013',
      content: 'Hiii',
    });

    const wrongChannel = await findLatestConversationForCustomer(
      prisma,
      TEST_TENANT_ID,
      'WEB',
      '971500000013',
    );
    expect(wrongChannel).toBeNull();

    const wrongTenant = await findLatestConversationForCustomer(
      prisma,
      OTHER_TENANT_ID,
      'WHATSAPP',
      '971500000013',
    );
    expect(wrongTenant).toBeNull();

    const found = await findLatestConversationForCustomer(
      prisma,
      TEST_TENANT_ID,
      'WHATSAPP',
      '971500000013',
    );
    expect(found?.id).toBe(conversation.id);
  });

  it('appends a message to an existing conversation instead of creating a new one', async () => {
    const { conversation, message: firstMessage } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000014',
      content: 'Hiii',
    });

    const appended = await appendMessageToConversation(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      content: 'Yes',
    });

    expect(appended?.conversation.id).toBe(conversation.id);
    expect(appended?.message.id).not.toBe(firstMessage.id);
    expect(appended?.message.content).toBe('Yes');

    const found = await findConversationById(prisma, TEST_TENANT_ID, conversation.id);
    expect(found?.messages).toHaveLength(2);
  });

  it('returns null when appending to a conversation outside the tenant, without creating a message', async () => {
    const { conversation } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000015',
      content: 'Hiii',
    });

    const appended = await appendMessageToConversation(prisma, {
      tenantId: OTHER_TENANT_ID,
      conversationId: conversation.id,
      content: 'Yes',
    });
    expect(appended).toBeNull();

    const found = await findConversationById(prisma, TEST_TENANT_ID, conversation.id);
    expect(found?.messages).toHaveLength(1);
  });

  it('updates the stage only within the correct tenant', async () => {
    const { conversation } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000016',
      content: 'Hiii',
    });

    const wrongTenantResult = await updateConversationStage(
      prisma,
      OTHER_TENANT_ID,
      conversation.id,
      'AWAITING_BOOKING_CONFIRMATION',
    );
    expect(wrongTenantResult.count).toBe(0);

    const result = await updateConversationStage(
      prisma,
      TEST_TENANT_ID,
      conversation.id,
      'AWAITING_BOOKING_CONFIRMATION',
    );
    expect(result.count).toBe(1);

    const found = await findConversationById(prisma, TEST_TENANT_ID, conversation.id);
    expect(found?.stage).toBe('AWAITING_BOOKING_CONFIRMATION');
  });

  it('defaults cycleStartedAt to createdAt, and updateConversationStage can bump it', async () => {
    const { conversation } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000017',
      content: 'Hiii',
    });
    expect(conversation.cycleStartedAt.getTime()).toBe(conversation.createdAt.getTime());

    const newCycleStart = new Date(conversation.createdAt.getTime() + 60_000);
    await updateConversationStage(
      prisma,
      TEST_TENANT_ID,
      conversation.id,
      'AWAITING_BOOKING_CONFIRMATION',
      newCycleStart,
    );

    const found = await findConversationById(prisma, TEST_TENANT_ID, conversation.id);
    expect(found?.cycleStartedAt.getTime()).toBe(newCycleStart.getTime());
  });

  it('leaves cycleStartedAt untouched when updateConversationStage is called without one', async () => {
    const { conversation } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000018',
      content: 'Hiii',
    });

    await updateConversationStage(prisma, TEST_TENANT_ID, conversation.id, 'COLLECTING_VEHICLE');

    const found = await findConversationById(prisma, TEST_TENANT_ID, conversation.id);
    expect(found?.cycleStartedAt.getTime()).toBe(conversation.cycleStartedAt.getTime());
  });
});
