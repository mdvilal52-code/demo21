import type { VehicleDeterminationResult } from '@ai-concierge/domain';
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
import { createVehicle, findVehiclesByIds } from './vehicleRepository.js';
import {
  createVehicleDetermination,
  findLatestVehicleDeterminationForMessage,
} from './vehicleDeterminationRepository.js';

describe('vehicleDeterminationRepository', () => {
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
      content: 'I want a Lamborghini Urus',
    });
    messageId = message.id;
  });

  it('persists a resolved determination with the resolved vehicle id', async () => {
    const created = await createVehicle(prisma, {
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
    // Domain-shaped (public) vehicle, the same shape VehicleCatalogProvider hands the orchestrator.
    const [vehicle] = await findVehiclesByIds(prisma, TEST_TENANT_ID, [created.id]);

    const result: VehicleDeterminationResult = {
      status: 'RESOLVED',
      resolvedVehicle: vehicle!,
      confidence: 0.95,
      ambiguities: [],
      validationErrors: [],
      alternatives: [],
      flags: { promptInjectionDetected: false },
      modelMetadata: { engine: 'vehicle-validation-v1', version: '0.1.0', deterministic: true },
    };

    const row = await createVehicleDetermination(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      result,
    });
    expect(row.status).toBe('RESOLVED');
    expect(row.resolvedVehicleId).toBe(created.id);
    expect(row.confidence).toBe(0.95);
  });

  it('persists a needs-clarification determination with alternatives and no resolved vehicle', async () => {
    const result: VehicleDeterminationResult = {
      status: 'NEEDS_CLARIFICATION',
      resolvedVehicle: null,
      confidence: 0.4,
      ambiguities: [
        {
          field: 'vehicle',
          code: 'CATEGORY_ONLY_MULTIPLE_MATCHES',
          message: '2 vehicles matched; please choose one',
          raw: 'SUV',
        },
      ],
      validationErrors: [],
      alternatives: [],
      flags: { promptInjectionDetected: false },
      modelMetadata: { engine: 'vehicle-validation-v1', version: '0.1.0', deterministic: true },
    };

    const row = await createVehicleDetermination(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId,
      result,
    });
    expect(row.status).toBe('NEEDS_CLARIFICATION');
    expect(row.resolvedVehicleId).toBeNull();
    expect(row.ambiguities).toEqual(result.ambiguities);
  });

  it('finds the latest determination for a message, scoped to the correct tenant', async () => {
    const result: VehicleDeterminationResult = {
      status: 'UNSUPPORTED',
      resolvedVehicle: null,
      confidence: 0.1,
      ambiguities: [],
      validationErrors: [
        {
          field: 'vehicle',
          code: 'UNKNOWN_VEHICLE',
          message: '"Toyota Corolla" is not a vehicle we currently offer',
          severity: 'ERROR',
        },
      ],
      alternatives: [],
      flags: { promptInjectionDetected: false },
      modelMetadata: { engine: 'vehicle-validation-v1', version: '0.1.0', deterministic: true },
    };
    await createVehicleDetermination(prisma, { tenantId: TEST_TENANT_ID, messageId, result });

    const found = await findLatestVehicleDeterminationForMessage(prisma, TEST_TENANT_ID, messageId);
    expect(found?.messageId).toBe(messageId);
    expect(found?.validationErrors).toEqual(result.validationErrors);

    const foundFromOtherTenant = await findLatestVehicleDeterminationForMessage(
      prisma,
      OTHER_TENANT_ID,
      messageId,
    );
    expect(foundFromOtherTenant).toBeNull();
  });
});
