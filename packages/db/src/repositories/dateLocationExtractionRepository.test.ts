import type { DateLocationExtractionResult } from '@ai-concierge/domain';
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
  appendMessageToConversation,
} from './conversationRepository.js';
import {
  createDateLocationExtraction,
  findDateLocationExtractionsForConversation,
  findLatestDateLocationExtractionForMessage,
} from './dateLocationExtractionRepository.js';

const SAMPLE_RESULT: DateLocationExtractionResult = {
  pickupDate: '2026-10-15T06:00:00.000Z',
  returnDate: '2026-10-19T06:00:00.000Z',
  timezone: 'Asia/Dubai',
  pickupLocation: {
    raw: 'Dubai Marina',
    normalized: 'Dubai Marina',
    city: 'Dubai',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: 'CITY_AREA',
  },
  dropoffLocation: null,
  locationType: 'CITY_AREA',
  confidence: 0.9,
  ambiguities: [],
  validationErrors: [],
  flags: { promptInjectionDetected: false },
  modelMetadata: { engine: 'temporal-validation-v1', version: '0.1.0', deterministic: true },
};

describe('dateLocationExtractionRepository', () => {
  let prisma: PrismaClient;
  let messageId: string;

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
    const { message } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: 'session-1',
      content: 'pickup 15-19 Oct from Dubai Marina',
    });
    messageId = message.id;
  });

  it('persists a full extraction result', async () => {
    const row = await createDateLocationExtraction(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      result: SAMPLE_RESULT,
    });
    expect(row.pickupDate?.toISOString()).toBe('2026-10-15T06:00:00.000Z');
    expect(row.returnDate?.toISOString()).toBe('2026-10-19T06:00:00.000Z');
    expect(row.locationType).toBe('CITY_AREA');
    expect(row.confidence).toBe(0.9);
    expect(row.pickupLocation).toEqual(SAMPLE_RESULT.pickupLocation);
  });

  it('persists null dates/locations for a low-confidence result without them', async () => {
    const row = await createDateLocationExtraction(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      result: {
        ...SAMPLE_RESULT,
        pickupDate: null,
        returnDate: null,
        pickupLocation: null,
        dropoffLocation: null,
        locationType: null,
        confidence: 0.1,
        ambiguities: [{ field: 'pickupDate', code: 'VAGUE_RELATIVE_DATE', message: 'x' }],
      },
    });
    expect(row.pickupDate).toBeNull();
    expect(row.pickupLocation).toBeNull();
    expect(row.ambiguities).toEqual([
      { field: 'pickupDate', code: 'VAGUE_RELATIVE_DATE', message: 'x' },
    ]);
  });

  it('finds the latest extraction for a message, scoped to the correct tenant', async () => {
    await createDateLocationExtraction(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      result: SAMPLE_RESULT,
    });

    const found = await findLatestDateLocationExtractionForMessage(
      prisma,
      TEST_TENANT_ID,
      messageId,
    );
    expect(found?.messageId).toBe(messageId);

    const foundFromOtherTenant = await findLatestDateLocationExtractionForMessage(
      prisma,
      OTHER_TENANT_ID,
      messageId,
    );
    expect(foundFromOtherTenant).toBeNull();
  });

  it('stores validation errors verbatim', async () => {
    const row = await createDateLocationExtraction(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      result: {
        ...SAMPLE_RESULT,
        validationErrors: [
          {
            field: 'returnDate',
            code: 'RETURN_BEFORE_OR_EQUAL_PICKUP',
            message: 'bad',
            severity: 'ERROR',
          },
        ],
      },
    });
    expect(row.validationErrors).toEqual([
      {
        field: 'returnDate',
        code: 'RETURN_BEFORE_OR_EQUAL_PICKUP',
        message: 'bad',
        severity: 'ERROR',
      },
    ]);
  });

  it('returns every extraction across a conversation, oldest first, scoped to the correct tenant', async () => {
    const { conversation, message: firstMessage } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000001',
      content: 'pickup 15 Oct from Dubai Marina',
    });
    await createDateLocationExtraction(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: firstMessage.id,
      result: { ...SAMPLE_RESULT, returnDate: null, dropoffLocation: null },
    });

    const appended = await appendMessageToConversation(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      content: 'return 19 Oct',
    });
    await createDateLocationExtraction(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: appended!.message.id,
      result: { ...SAMPLE_RESULT, pickupDate: null, pickupLocation: null },
    });

    const rows = await findDateLocationExtractionsForConversation(
      prisma,
      TEST_TENANT_ID,
      conversation.id,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.messageId).toBe(firstMessage.id);
    expect(rows[0]?.pickupDate?.toISOString()).toBe('2026-10-15T06:00:00.000Z');
    expect(rows[0]?.returnDate).toBeNull();
    expect(rows[1]?.messageId).toBe(appended!.message.id);
    expect(rows[1]?.pickupDate).toBeNull();
    expect(rows[1]?.returnDate?.toISOString()).toBe('2026-10-19T06:00:00.000Z');

    const fromOtherTenant = await findDateLocationExtractionsForConversation(
      prisma,
      OTHER_TENANT_ID,
      conversation.id,
    );
    expect(fromOtherTenant).toHaveLength(0);
  });

  it('excludes rows from before a given `since` cutoff (booking-cycle scoping)', async () => {
    const { conversation, message: firstMessage } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000019',
      content: 'a finished, earlier booking',
    });
    await createDateLocationExtraction(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: firstMessage.id,
      result: SAMPLE_RESULT,
    });

    const cutoff = new Date(Date.now() + 50);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const appended = await appendMessageToConversation(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      content: 'a new, unrelated request',
    });
    await createDateLocationExtraction(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: appended!.message.id,
      result: { ...SAMPLE_RESULT, pickupDate: null, returnDate: null },
    });

    const unscoped = await findDateLocationExtractionsForConversation(
      prisma,
      TEST_TENANT_ID,
      conversation.id,
    );
    expect(unscoped).toHaveLength(2);

    const scoped = await findDateLocationExtractionsForConversation(
      prisma,
      TEST_TENANT_ID,
      conversation.id,
      cutoff,
    );
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.messageId).toBe(appended!.message.id);
  });
});
