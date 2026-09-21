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
import {
  createConversationWithMessage,
  appendMessageToConversation,
} from './conversationRepository.js';
import { createVehicle, findVehiclesByIds } from './vehicleRepository.js';
import {
  createVehicleDetermination,
  findLatestVehicleDeterminationForMessage,
  findVehicleDeterminationsForConversation,
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

  it('returns every determination across a conversation, oldest first, with the resolved vehicle included', async () => {
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
    const [vehicle] = await findVehiclesByIds(prisma, TEST_TENANT_ID, [created.id]);

    const { conversation, message: firstMessage } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000002',
      content: 'I want a Lamborghini Urus',
    });
    await createVehicleDetermination(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: firstMessage.id,
      result: {
        status: 'RESOLVED',
        resolvedVehicle: vehicle!,
        confidence: 0.95,
        ambiguities: [],
        validationErrors: [],
        alternatives: [],
        flags: { promptInjectionDetected: false },
        modelMetadata: { engine: 'vehicle-validation-v1', version: '0.1.0', deterministic: true },
      },
    });

    const appended = await appendMessageToConversation(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      content: 'pickup 15 Oct, Dubai Marina',
    });
    await createVehicleDetermination(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: appended!.message.id,
      result: {
        status: 'UNSUPPORTED',
        resolvedVehicle: null,
        confidence: 0.1,
        ambiguities: [],
        validationErrors: [
          {
            field: 'vehicle',
            code: 'UNKNOWN_VEHICLE',
            message: 'no vehicle mentioned',
            severity: 'ERROR',
          },
        ],
        alternatives: [],
        flags: { promptInjectionDetected: false },
        modelMetadata: { engine: 'vehicle-validation-v1', version: '0.1.0', deterministic: true },
      },
    });

    const rows = await findVehicleDeterminationsForConversation(
      prisma,
      TEST_TENANT_ID,
      conversation.id,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('RESOLVED');
    expect(rows[0]?.resolvedVehicle?.model).toBe('Urus');
    expect(rows[1]?.status).toBe('UNSUPPORTED');
    expect(rows[1]?.resolvedVehicle).toBeNull();

    const fromOtherTenant = await findVehicleDeterminationsForConversation(
      prisma,
      OTHER_TENANT_ID,
      conversation.id,
    );
    expect(fromOtherTenant).toHaveLength(0);
  });

  it('excludes rows from before a given `since` cutoff (booking-cycle scoping)', async () => {
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
    const [vehicle] = await findVehiclesByIds(prisma, TEST_TENANT_ID, [created.id]);

    const { conversation, message: firstMessage } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000020',
      content: 'a finished, earlier booking',
    });
    await createVehicleDetermination(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: firstMessage.id,
      result: {
        status: 'RESOLVED',
        resolvedVehicle: vehicle!,
        confidence: 0.95,
        ambiguities: [],
        validationErrors: [],
        alternatives: [],
        flags: { promptInjectionDetected: false },
        modelMetadata: { engine: 'vehicle-validation-v1', version: '0.1.0', deterministic: true },
      },
    });

    const cutoff = new Date(Date.now() + 50);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const appended = await appendMessageToConversation(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      content: 'a new, unrelated request',
    });
    await createVehicleDetermination(prisma, {
      tenantId: TEST_TENANT_ID,
      messageId: appended!.message.id,
      result: {
        status: 'UNSUPPORTED',
        resolvedVehicle: null,
        confidence: 0.1,
        ambiguities: [],
        validationErrors: [
          {
            field: 'vehicle',
            code: 'UNKNOWN_VEHICLE',
            message: 'not mentioned',
            severity: 'ERROR',
          },
        ],
        alternatives: [],
        flags: { promptInjectionDetected: false },
        modelMetadata: { engine: 'vehicle-validation-v1', version: '0.1.0', deterministic: true },
      },
    });

    const unscoped = await findVehicleDeterminationsForConversation(
      prisma,
      TEST_TENANT_ID,
      conversation.id,
    );
    expect(unscoped).toHaveLength(2);

    const scoped = await findVehicleDeterminationsForConversation(
      prisma,
      TEST_TENANT_ID,
      conversation.id,
      cutoff,
    );
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.messageId).toBe(appended!.message.id);
  });
});
