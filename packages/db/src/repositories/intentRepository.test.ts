import type { IntentResult } from '@ai-concierge/domain';
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
} from './conversationRepository.js';
import {
  createIntentRecord,
  findLatestIntentRecordForMessage,
  hasBookingRequestIntentInConversation,
} from './intentRepository.js';

function fakeIntent(overrides: Partial<IntentResult> = {}): IntentResult {
  return {
    intentType: 'UNKNOWN',
    status: 'NEEDS_CLARIFICATION',
    confidence: 0.9,
    entities: { language: 'en', urgency: 'LOW' },
    missingFields: [],
    flags: { promptInjectionDetected: false },
    modelMetadata: { engine: 'rule-based-v1', version: '0.1.0', deterministic: true },
    ...overrides,
  };
}

describe('intentRepository', () => {
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

  it('persists an intent record and reads it back as the latest for that message', async () => {
    const { message } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: 'session-1',
      content: 'I want to rent a car',
    });

    await createIntentRecord(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: message.id,
      intentResult: fakeIntent({ intentType: 'BOOKING_REQUEST', status: 'RECOGNIZED' }),
    });

    const found = await findLatestIntentRecordForMessage(prisma, TEST_TENANT_ID, message.id);
    expect(found?.intentType).toBe('BOOKING_REQUEST');

    const foundFromOtherTenant = await findLatestIntentRecordForMessage(
      prisma,
      OTHER_TENANT_ID,
      message.id,
    );
    expect(foundFromOtherTenant).toBeNull();
  });

  describe('hasBookingRequestIntentInConversation', () => {
    it('is false for a conversation that never had a BOOKING_REQUEST intent', async () => {
      const { conversation, message } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971500000001',
        content: 'Hi',
      });
      await createIntentRecord(prisma, {
        tenantId: TEST_TENANT_ID,
        messageId: message.id,
        intentResult: fakeIntent({ intentType: 'UNKNOWN' }),
      });

      const result = await hasBookingRequestIntentInConversation(
        prisma,
        TEST_TENANT_ID,
        conversation.id,
      );
      expect(result).toBe(false);
    });

    it('is true once any message in the conversation was recognized as BOOKING_REQUEST, even an earlier one', async () => {
      const { conversation, message: first } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971500000002',
        content: 'I want to rent a car',
      });
      await createIntentRecord(prisma, {
        tenantId: TEST_TENANT_ID,
        messageId: first.id,
        intentResult: fakeIntent({ intentType: 'BOOKING_REQUEST', status: 'NEEDS_CLARIFICATION' }),
      });

      const second = await appendMessageToConversation(
        prisma,
        TEST_TENANT_ID,
        conversation.id,
        'hmm not sure what you mean',
      );
      await createIntentRecord(prisma, {
        tenantId: TEST_TENANT_ID,
        messageId: second!.id,
        intentResult: fakeIntent({ intentType: 'UNKNOWN' }),
      });

      const result = await hasBookingRequestIntentInConversation(
        prisma,
        TEST_TENANT_ID,
        conversation.id,
      );
      expect(result).toBe(true);
    });

    it('is scoped to the correct tenant', async () => {
      const { conversation, message } = await createConversationWithMessage(prisma, {
        tenantId: TEST_TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971500000003',
        content: 'I want to rent a car',
      });
      await createIntentRecord(prisma, {
        tenantId: TEST_TENANT_ID,
        messageId: message.id,
        intentResult: fakeIntent({ intentType: 'BOOKING_REQUEST', status: 'RECOGNIZED' }),
      });

      const resultFromOtherTenant = await hasBookingRequestIntentInConversation(
        prisma,
        OTHER_TENANT_ID,
        conversation.id,
      );
      expect(resultFromOtherTenant).toBe(false);
    });

    it('is false for a conversation that does not exist', async () => {
      const result = await hasBookingRequestIntentInConversation(
        prisma,
        TEST_TENANT_ID,
        '00000000-0000-0000-0000-000000009999',
      );
      expect(result).toBe(false);
    });
  });
});
