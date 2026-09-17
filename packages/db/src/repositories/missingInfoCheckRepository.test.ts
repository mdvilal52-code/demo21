import type { MissingInfoResult } from '@ai-concierge/domain';
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
  createMissingInfoCheck,
  findLatestMissingInfoCheckForMessage,
} from './missingInfoCheckRepository.js';

const EMPTY_COLLECTED = {
  pickupDate: null,
  returnDate: null,
  pickupLocation: null,
  dropoffLocation: null,
  vehicle: null,
};

describe('missingInfoCheckRepository', () => {
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
      content: 'I want to rent a car',
    });
    messageId = message.id;
  });

  it('persists a NEEDS_INFO check with missing fields and a clarification prompt', async () => {
    const result: MissingInfoResult = {
      status: 'NEEDS_INFO',
      collected: EMPTY_COLLECTED,
      missingFields: [{ field: 'PICKUP_DATE', reason: 'NOT_PROVIDED' }],
      clarificationPrompt: 'Could you please confirm when you would like to pick up the car?',
      expiresAt: '2026-09-18T00:00:00.000Z',
      flags: { promptInjectionDetectedAnywhere: false },
      modelMetadata: { engine: 'missing-info-evaluator-v1', version: '0.1.0', deterministic: true },
    };

    const row = await createMissingInfoCheck(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      result,
    });
    expect(row.status).toBe('NEEDS_INFO');
    expect(row.clarificationPrompt).toBe(result.clarificationPrompt);
    expect(row.expiresAt.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(row.missingFields).toEqual(result.missingFields);
  });

  it('persists a COMPLETE check with a null clarification prompt', async () => {
    const result: MissingInfoResult = {
      status: 'COMPLETE',
      collected: {
        ...EMPTY_COLLECTED,
        pickupDate: '2026-10-15T06:00:00.000Z',
        returnDate: '2026-10-19T06:00:00.000Z',
      },
      missingFields: [],
      clarificationPrompt: null,
      expiresAt: '2026-09-18T00:00:00.000Z',
      flags: { promptInjectionDetectedAnywhere: false },
      modelMetadata: { engine: 'missing-info-evaluator-v1', version: '0.1.0', deterministic: true },
    };

    const row = await createMissingInfoCheck(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      result,
    });
    expect(row.status).toBe('COMPLETE');
    expect(row.clarificationPrompt).toBeNull();
    expect(row.collected).toEqual(result.collected);
  });

  it('finds the latest check for a message, scoped to the correct tenant', async () => {
    const result: MissingInfoResult = {
      status: 'EXPIRED',
      collected: EMPTY_COLLECTED,
      missingFields: [{ field: 'VEHICLE', reason: 'NOT_PROVIDED' }],
      clarificationPrompt: null,
      expiresAt: '2026-09-16T00:00:00.000Z',
      flags: { promptInjectionDetectedAnywhere: true },
      modelMetadata: { engine: 'missing-info-evaluator-v1', version: '0.1.0', deterministic: true },
    };
    await createMissingInfoCheck(prisma, { tenantId: TEST_TENANT_ID, messageId, result });

    const found = await findLatestMissingInfoCheckForMessage(prisma, TEST_TENANT_ID, messageId);
    expect(found?.status).toBe('EXPIRED');
    expect(found?.flags).toEqual({ promptInjectionDetectedAnywhere: true });

    const foundFromOtherTenant = await findLatestMissingInfoCheckForMessage(
      prisma,
      OTHER_TENANT_ID,
      messageId,
    );
    expect(foundFromOtherTenant).toBeNull();
  });
});
