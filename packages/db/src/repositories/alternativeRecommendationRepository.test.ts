import type {
  AlternativeCandidate,
  RecommendAlternativesResult,
  TenantId,
} from '@ai-concierge/domain';
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
  createAlternativeRecommendation,
  findLatestAlternativeRecommendationForMessage,
} from './alternativeRecommendationRepository.js';

function fakeCandidate(vehicleId: string): AlternativeCandidate {
  return {
    vehicle: {
      id: vehicleId,
      make: 'Rolls-Royce',
      model: 'Cullinan',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      availabilityStatus: 'AVAILABLE',
      pricingProfile: { currency: 'AED', dailyRate: 4200 },
      active: true,
    },
    availabilitySource: 'database-fleet',
    availabilityCheckedAt: '2026-10-01T00:00:00.000Z',
    priceDifference: 700,
    currency: 'AED',
    reason: 'Rolls-Royce Cullinan: same category (SUV), same luxury tier (ULTRA_LUXURY).',
  };
}

function fakeResult(
  requestedVehicleId: string,
  overrides: Partial<RecommendAlternativesResult> = {},
): RecommendAlternativesResult {
  return {
    status: 'NO_ALTERNATIVES',
    requestedVehicleId,
    primary: null,
    secondary: null,
    consideredCount: 0,
    modelMetadata: {
      engine: 'alternative-recommendation-orchestrator',
      version: '1.0.0',
      deterministic: true,
    },
    checkedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

async function seedConversationMessage(prisma: PrismaClient, tenantId: TenantId) {
  const conversation = await prisma.conversation.create({
    data: { tenantId, channel: 'WEB', customerRef: 'customer-1' },
  });
  const message = await prisma.message.create({
    data: { conversationId: conversation.id, content: 'Any alternatives to the Urus?' },
  });
  return message;
}

describe('alternativeRecommendationRepository', () => {
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

  it('persists a NO_ALTERNATIVES result with null primary/secondary and reads it back', async () => {
    const requested = await createVehicle(prisma, {
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
    const message = await seedConversationMessage(prisma, TEST_TENANT_ID);

    await createAlternativeRecommendation(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: message.id,
      result: fakeResult(requested.id),
    });

    const latest = await findLatestAlternativeRecommendationForMessage(
      prisma,
      TEST_TENANT_ID,
      message.id,
    );
    expect(latest?.status).toBe('NO_ALTERNATIVES');
    expect(latest?.primary).toBeNull();
    expect(latest?.secondary).toBeNull();
    expect(latest?.consideredCount).toBe(0);
  });

  it('persists a primary/secondary pair and reads back the latest run for a message', async () => {
    const requested = await createVehicle(prisma, {
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
    const alt = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Rolls-Royce',
      model: 'Cullinan',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 4200 },
    });
    const message = await seedConversationMessage(prisma, TEST_TENANT_ID);

    await createAlternativeRecommendation(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: message.id,
      result: fakeResult(requested.id, {
        status: 'ALTERNATIVES_FOUND',
        primary: fakeCandidate(alt.id),
        consideredCount: 3,
      }),
    });
    const second = await createAlternativeRecommendation(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: message.id,
      result: fakeResult(requested.id, {
        status: 'ALTERNATIVES_FOUND',
        primary: fakeCandidate(alt.id),
        consideredCount: 4,
      }),
    });

    const latest = await findLatestAlternativeRecommendationForMessage(
      prisma,
      TEST_TENANT_ID,
      message.id,
    );
    expect(latest?.id).toBe(second.id);
    expect(latest?.consideredCount).toBe(4);
    expect((latest?.primary as { vehicle: { id: string } } | null)?.vehicle.id).toBe(alt.id);
  });

  it('scopes reads to the requesting tenant (tenant isolation)', async () => {
    const requested = await createVehicle(prisma, {
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
    const message = await seedConversationMessage(prisma, OTHER_TENANT_ID);
    await createAlternativeRecommendation(prisma, {
      tenantId: OTHER_TENANT_ID,
      messageId: message.id,
      result: fakeResult(requested.id),
    });

    const crossTenantRead = await findLatestAlternativeRecommendationForMessage(
      prisma,
      TEST_TENANT_ID,
      message.id,
    );
    expect(crossTenantRead).toBeNull();
  });
});
