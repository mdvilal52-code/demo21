import { AppError, type ConversationStateData } from '@ai-concierge/domain';
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
import { createIntentRecord, findLatestIntentRecordForConversation } from './intentRepository.js';
import {
  createDateLocationExtraction,
  findLatestDateLocationExtractionForConversation,
} from './dateLocationExtractionRepository.js';
import { hasVehicleDeterminationForConversation } from './vehicleDeterminationRepository.js';
import {
  createMissingInformationState,
  findMissingInformationState,
  saveMissingInformationState,
  updateMissingInformationState,
} from './missingInformationRepository.js';

function buildState(
  conversationId: string,
  overrides: Partial<ConversationStateData> = {},
): ConversationStateData {
  return {
    tenantId: TEST_TENANT_ID,
    conversationId,
    status: 'AWAITING_CUSTOMER',
    answers: [],
    askedFieldKeys: [],
    pendingQuestions: [],
    corrections: [],
    contradictions: [],
    flags: { promptInjectionDetected: false, piiDetected: false },
    turnCount: 0,
    version: 0,
    lastProcessedMessageId: null,
    ...overrides,
  };
}

describe('missingInformationRepository', () => {
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
    const { conversation } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: 'session-1',
      content: 'I need a car',
    });
    conversationId = conversation.id;
  });

  it('returns null when no state exists yet', async () => {
    const found = await findMissingInformationState(prisma, TEST_TENANT_ID, conversationId);
    expect(found).toBeNull();
  });

  it('creates and finds a state, scoped to the correct tenant', async () => {
    await createMissingInformationState(prisma, buildState(conversationId));

    const found = await findMissingInformationState(prisma, TEST_TENANT_ID, conversationId);
    expect(found?.conversationId).toBe(conversationId);
    expect(found?.status).toBe('AWAITING_CUSTOMER');

    const foundFromOtherTenant = await findMissingInformationState(
      prisma,
      OTHER_TENANT_ID,
      conversationId,
    );
    expect(foundFromOtherTenant).toBeNull();
  });

  it('rejects a second create for the same conversation with a structured CONFLICT', async () => {
    await createMissingInformationState(prisma, buildState(conversationId));
    await expect(
      createMissingInformationState(prisma, buildState(conversationId)),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('updates the state and increments the version when the expected version matches', async () => {
    await createMissingInformationState(prisma, buildState(conversationId));
    const updated = await updateMissingInformationState(
      prisma,
      buildState(conversationId, { status: 'COMPLETE', turnCount: 1 }),
      0,
    );
    expect(updated.status).toBe('COMPLETE');
    expect(updated.version).toBe(1);
  });

  it('rejects an update against a stale version with a structured CONFLICT', async () => {
    await createMissingInformationState(prisma, buildState(conversationId));
    await updateMissingInformationState(prisma, buildState(conversationId, { turnCount: 1 }), 0);

    await expect(
      updateMissingInformationState(prisma, buildState(conversationId, { turnCount: 2 }), 0),
    ).rejects.toThrow(AppError);
  });

  it('saveMissingInformationState creates on a null prior version and updates otherwise', async () => {
    const created = await saveMissingInformationState(prisma, buildState(conversationId), null);
    expect(created.version).toBe(0);

    const updated = await saveMissingInformationState(
      prisma,
      buildState(conversationId, { turnCount: 1 }),
      created.version,
    );
    expect(updated.version).toBe(1);
    expect(updated.turnCount).toBe(1);
  });
});

describe('conversation-scoped Step 1-3 reads for Step 4', () => {
  let prisma: PrismaClient;
  let conversationId: string;
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
    const { conversation, message } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: 'session-1',
      content: 'I need a car',
    });
    conversationId = conversation.id;
    messageId = message.id;
  });

  it('finds Step 1 entities by conversation, scoped to the correct tenant', async () => {
    await createIntentRecord(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      intentResult: {
        intentType: 'BOOKING_REQUEST',
        status: 'RECOGNIZED',
        confidence: 0.9,
        entities: { driverRequired: true, language: 'en', urgency: 'LOW' },
        missingFields: [],
        flags: { promptInjectionDetected: false },
        modelMetadata: { engine: 'rule-based-v1', version: '0.1.0', deterministic: true },
      },
    });

    const found = await findLatestIntentRecordForConversation(
      prisma,
      TEST_TENANT_ID,
      conversationId,
    );
    expect(found?.entities.driverRequired).toBe(true);

    const foundFromOtherTenant = await findLatestIntentRecordForConversation(
      prisma,
      OTHER_TENANT_ID,
      conversationId,
    );
    expect(foundFromOtherTenant).toBeNull();
  });

  it('finds Step 2 locations by conversation, scoped to the correct tenant', async () => {
    const hotel = {
      raw: 'Atlantis The Palm',
      normalized: 'Atlantis The Palm',
      city: 'Dubai',
      country: 'AE',
      timezone: 'Asia/Dubai',
      locationType: 'HOTEL' as const,
    };
    await createDateLocationExtraction(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      result: {
        pickupDate: null,
        returnDate: null,
        timezone: 'Asia/Dubai',
        pickupLocation: hotel,
        dropoffLocation: null,
        locationType: 'HOTEL',
        confidence: 0.9,
        ambiguities: [],
        validationErrors: [],
        flags: { promptInjectionDetected: false },
        modelMetadata: { engine: 'temporal-validation-v1', version: '0.1.0', deterministic: true },
      },
    });

    const found = await findLatestDateLocationExtractionForConversation(
      prisma,
      TEST_TENANT_ID,
      conversationId,
    );
    expect(found?.pickupLocation?.locationType).toBe('HOTEL');
    expect(found?.dropoffLocation).toBeNull();

    const foundFromOtherTenant = await findLatestDateLocationExtractionForConversation(
      prisma,
      OTHER_TENANT_ID,
      conversationId,
    );
    expect(foundFromOtherTenant).toBeNull();
  });

  it('reports whether Step 3 ran at all for a conversation, scoped to the correct tenant', async () => {
    expect(
      await hasVehicleDeterminationForConversation(prisma, TEST_TENANT_ID, conversationId),
    ).toBe(false);

    await prisma.vehicleDetermination.create({
      data: {
        tenantId: TEST_TENANT_ID,
        messageId,
        status: 'UNSUPPORTED',
        confidence: 0.1,
        ambiguities: [],
        validationErrors: [],
        alternatives: [],
        flags: { promptInjectionDetected: false },
        modelMetadata: { engine: 'vehicle-validation-v1', version: '0.1.0', deterministic: true },
      },
    });

    expect(
      await hasVehicleDeterminationForConversation(prisma, TEST_TENANT_ID, conversationId),
    ).toBe(true);
    expect(
      await hasVehicleDeterminationForConversation(prisma, OTHER_TENANT_ID, conversationId),
    ).toBe(false);
  });

  it('appends a follow-up message to an existing conversation', async () => {
    const appended = await appendMessageToConversation(
      prisma,
      TEST_TENANT_ID,
      conversationId,
      'my flight is EK203',
    );
    expect(appended?.conversationId).toBe(conversationId);
    expect(appended?.content).toBe('my flight is EK203');

    const messageCount = await prisma.message.count({ where: { conversationId } });
    expect(messageCount).toBe(2);
  });

  it('returns null appending to a conversation from another tenant (defense in depth)', async () => {
    const appended = await appendMessageToConversation(
      prisma,
      OTHER_TENANT_ID,
      conversationId,
      'hello',
    );
    expect(appended).toBeNull();
  });

  it('returns null appending to a conversation that does not exist', async () => {
    const appended = await appendMessageToConversation(
      prisma,
      TEST_TENANT_ID,
      '00000000-0000-0000-0000-000000009999',
      'hello',
    );
    expect(appended).toBeNull();
  });
});
