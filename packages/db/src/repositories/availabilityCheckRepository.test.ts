import type { AvailabilityCheckResult, TenantId } from '@ai-concierge/domain';
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
  createAvailabilityCheck,
  findLatestAvailabilityCheckForMessage,
} from './availabilityCheckRepository.js';

function fakeResult(
  vehicleId: string,
  overrides: Partial<AvailabilityCheckResult> = {},
): AvailabilityCheckResult {
  return {
    status: 'AVAILABLE',
    vehicleId,
    pickupDate: '2026-10-05T10:00:00.000Z',
    returnDate: '2026-10-08T10:00:00.000Z',
    hold: null,
    source: 'database-fleet',
    reason: null,
    retryable: false,
    checkedAt: '2026-10-01T00:00:00.000Z',
    modelMetadata: { engine: 'reservation-lock-service', version: '1.0.0', deterministic: false },
    ...overrides,
  };
}

async function seedConversationMessage(prisma: PrismaClient, tenantId: TenantId) {
  const conversation = await prisma.conversation.create({
    data: { tenantId, channel: 'WEB', customerRef: 'customer-1' },
  });
  const message = await prisma.message.create({
    data: { conversationId: conversation.id, content: 'I want the Urus 5-8 Oct' },
  });
  return message;
}

describe('availabilityCheckRepository', () => {
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

  it('persists a check and reads back the latest one for a message', async () => {
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
    const message = await seedConversationMessage(prisma, TEST_TENANT_ID);

    await createAvailabilityCheck(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: message.id,
      result: fakeResult(vehicle.id, { status: 'UNAVAILABLE', reason: 'no capacity' }),
    });
    const second = await createAvailabilityCheck(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: message.id,
      result: fakeResult(vehicle.id, { status: 'AVAILABLE' }),
    });

    const latest = await findLatestAvailabilityCheckForMessage(prisma, TEST_TENANT_ID, message.id);
    expect(latest?.id).toBe(second.id);
    expect(latest?.status).toBe('AVAILABLE');
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
    const message = await seedConversationMessage(prisma, OTHER_TENANT_ID);
    await createAvailabilityCheck(prisma, {
      tenantId: OTHER_TENANT_ID,
      messageId: message.id,
      result: fakeResult(vehicle.id),
    });

    const crossTenantRead = await findLatestAvailabilityCheckForMessage(
      prisma,
      TEST_TENANT_ID,
      message.id,
    );
    expect(crossTenantRead).toBeNull();
  });
});
