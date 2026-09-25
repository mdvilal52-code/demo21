import type { QuoteSnapshot, TenantId } from '@ai-concierge/domain';
import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createVehicle } from './vehicleRepository.js';
import {
  acquireConversationQuoteLock,
  createQuote,
  findLatestQuoteForConversation,
} from './quoteRepository.js';

function fakeSnapshot(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return {
    quoteId: '22222222-2222-2222-2222-222222222222',
    version: 1,
    status: 'ISSUED',
    currency: 'AED',
    lineItems: [
      {
        category: 'BASE_RENTAL',
        code: 'BASE_RENTAL_DAILY',
        description: 'Urus — 4 day(s)',
        quantity: 4,
        unitAmount: { minorUnits: 350_000, currency: 'AED' },
        amount: { minorUnits: 1_400_000, currency: 'AED' },
      },
    ],
    taxes: [
      {
        code: 'VAT',
        description: 'VAT 5%',
        ratePercent: 5,
        amount: { minorUnits: 70_250, currency: 'AED' },
      },
    ],
    fees: [
      {
        code: 'SERVICE_FEE',
        description: 'Service fee',
        amount: { minorUnits: 5000, currency: 'AED' },
      },
    ],
    discounts: [],
    deposit: { minorUnits: 200_000, currency: 'AED' },
    total: { minorUnits: 1_475_250, currency: 'AED' },
    validUntil: '2026-10-02T00:00:00.000Z',
    pricingVersion: 'pricing-rules-v1',
    requiresHumanReview: false,
    reviewReasons: [],
    integrityHash: 'test-hash',
    modelMetadata: { engine: 'quote-service', version: '1.0.0', deterministic: true },
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

async function seedConversation(prisma: PrismaClient, tenantId: TenantId) {
  const conversation = await prisma.conversation.create({
    data: { tenantId, channel: 'WEB', customerRef: 'customer-1' },
  });
  const message = await prisma.message.create({
    data: { conversationId: conversation.id, content: 'What will this cost?' },
  });
  return { conversation, message };
}

describe('quoteRepository', () => {
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

  it('persists a quote and reads back the latest version for a conversation', async () => {
    const vehicle = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
    const { conversation, message } = await seedConversation(prisma, TEST_TENANT_ID);

    await createQuote(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      messageId: message.id,
      vehicleId: vehicle.id,
      snapshot: fakeSnapshot(),
    });

    const latest = await findLatestQuoteForConversation(prisma, TEST_TENANT_ID, conversation.id);
    expect(latest?.version).toBe(1);
    expect(latest?.status).toBe('ISSUED');
    expect((latest?.total as { minorUnits: number }).minorUnits).toBe(1_475_250);
  });

  it('returns the highest version when several versions exist for the same quoteId', async () => {
    const vehicle = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
    const { conversation, message } = await seedConversation(prisma, TEST_TENANT_ID);

    await createQuote(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      messageId: message.id,
      vehicleId: vehicle.id,
      snapshot: fakeSnapshot({ version: 1 }),
    });
    await createQuote(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      messageId: message.id,
      vehicleId: vehicle.id,
      snapshot: fakeSnapshot({ version: 2, requiresHumanReview: true, reviewReasons: ['test'] }),
    });

    const latest = await findLatestQuoteForConversation(prisma, TEST_TENANT_ID, conversation.id);
    expect(latest?.version).toBe(2);
    expect(latest?.requiresHumanReview).toBe(true);
  });

  it('rejects a duplicate (quoteId, version) pair — the unique-constraint backstop', async () => {
    const vehicle = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
    const { conversation, message } = await seedConversation(prisma, TEST_TENANT_ID);
    const snapshot = fakeSnapshot();

    await createQuote(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      messageId: message.id,
      vehicleId: vehicle.id,
      snapshot,
    });

    await expect(
      createQuote(prisma, {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        messageId: message.id,
        vehicleId: vehicle.id,
        snapshot,
      }),
    ).rejects.toThrow();
  });

  it('scopes reads to the requesting tenant (tenant isolation)', async () => {
    const vehicle = await createVehicle(prisma, {
      tenantId: OTHER_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
    const { conversation, message } = await seedConversation(prisma, OTHER_TENANT_ID);
    await createQuote(prisma, {
      tenantId: OTHER_TENANT_ID,
      conversationId: conversation.id,
      messageId: message.id,
      vehicleId: vehicle.id,
      snapshot: fakeSnapshot(),
    });

    const crossTenantRead = await findLatestQuoteForConversation(
      prisma,
      TEST_TENANT_ID,
      conversation.id,
    );
    expect(crossTenantRead).toBeNull();
  });

  it('acquireConversationQuoteLock prevents interleaved critical sections for the same conversation', async () => {
    const { conversation } = await seedConversation(prisma, TEST_TENANT_ID);
    let counter = 0;
    let activeCount = 0;
    let maxObservedConcurrent = 0;

    async function lockedWork(): Promise<void> {
      await prisma.$transaction(async (tx) => {
        await acquireConversationQuoteLock(tx, TEST_TENANT_ID, conversation.id);
        activeCount += 1;
        maxObservedConcurrent = Math.max(maxObservedConcurrent, activeCount);
        const before = counter;
        await new Promise((resolve) => setTimeout(resolve, 20));
        // A lost-update race (two transactions both reading `before` before
        // either writes) would corrupt this if the lock didn't serialize.
        counter = before + 1;
        activeCount -= 1;
      });
    }

    await Promise.all([lockedWork(), lockedWork(), lockedWork(), lockedWork(), lockedWork()]);

    expect(counter).toBe(5);
    expect(maxObservedConcurrent).toBe(1);
  });
});
