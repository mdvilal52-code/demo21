import { describe, expect, it } from 'vitest';
import { determineVehicleParamsSchema, determineVehicleResponseSchema } from './vehicle.js';

describe('determineVehicleParamsSchema', () => {
  it('accepts a valid conversation id', () => {
    expect(
      determineVehicleParamsSchema.safeParse({
        conversationId: '11111111-1111-1111-1111-111111111111',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-uuid conversation id', () => {
    expect(determineVehicleParamsSchema.safeParse({ conversationId: 'not-a-uuid' }).success).toBe(
      false,
    );
  });
});

describe('determineVehicleResponseSchema', () => {
  const determination = {
    status: 'RESOLVED',
    resolvedVehicle: {
      id: '22222222-2222-2222-2222-222222222222',
      make: 'Lamborghini',
      model: 'Urus',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      availabilityStatus: 'AVAILABLE',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
      active: true,
    },
    confidence: 0.95,
    ambiguities: [],
    validationErrors: [],
    alternatives: [],
    flags: { promptInjectionDetected: false },
    modelMetadata: { engine: 'vehicle-validation-v1', version: '0.1.0', deterministic: true },
  };

  it('accepts a full resolved response', () => {
    const result = determineVehicleResponseSchema.safeParse({
      conversationId: '11111111-1111-1111-1111-111111111111',
      messageId: '33333333-3333-3333-3333-333333333333',
      determination,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a response missing the determination', () => {
    const result = determineVehicleResponseSchema.safeParse({
      conversationId: '11111111-1111-1111-1111-111111111111',
      messageId: '33333333-3333-3333-3333-333333333333',
    });
    expect(result.success).toBe(false);
  });
});
