import { describe, expect, it } from 'vitest';
import { vehicleDeterminationResultSchema, vehicleSchema } from './vehicle.js';

const validVehicle = {
  id: '11111111-1111-1111-1111-111111111111',
  make: 'Lamborghini',
  model: 'Urus',
  category: 'SUV',
  luxuryTier: 'ULTRA_LUXURY',
  seats: 5,
  luggage: 4,
  transmission: 'AUTOMATIC',
  availabilityStatus: 'AVAILABLE',
  pricingProfile: { currency: 'AED', dailyRate: 3500, weeklyRate: 21000, depositAmount: 10000 },
  active: true,
};

describe('vehicleSchema', () => {
  it('accepts a well-formed vehicle', () => {
    expect(vehicleSchema.safeParse(validVehicle).success).toBe(true);
  });

  it('accepts a pricing profile with only the required fields', () => {
    const result = vehicleSchema.safeParse({
      ...validVehicle,
      pricingProfile: { currency: 'AED', dailyRate: 1800 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a currency that is not 3 letters', () => {
    const result = vehicleSchema.safeParse({
      ...validVehicle,
      pricingProfile: { ...validVehicle.pricingProfile, currency: 'DIRHAM' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative daily rate', () => {
    const result = vehicleSchema.safeParse({
      ...validVehicle,
      pricingProfile: { ...validVehicle.pricingProfile, dailyRate: -1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid category', () => {
    const result = vehicleSchema.safeParse({ ...validVehicle, category: 'HOVERCRAFT' });
    expect(result.success).toBe(false);
  });

  it('rejects zero seats', () => {
    const result = vehicleSchema.safeParse({ ...validVehicle, seats: 0 });
    expect(result.success).toBe(false);
  });
});

describe('vehicleDeterminationResultSchema', () => {
  const base = {
    status: 'RESOLVED',
    resolvedVehicle: validVehicle,
    confidence: 0.95,
    ambiguities: [],
    validationErrors: [],
    alternatives: [],
    flags: { promptInjectionDetected: false },
    modelMetadata: { engine: 'vehicle-validation-v1', version: '0.1.0', deterministic: true },
  };

  it('accepts a resolved result', () => {
    expect(vehicleDeterminationResultSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a needs-clarification result with alternatives and no resolved vehicle', () => {
    const result = vehicleDeterminationResultSchema.safeParse({
      ...base,
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
      alternatives: [validVehicle],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an unsupported result with a validation error', () => {
    const result = vehicleDeterminationResultSchema.safeParse({
      ...base,
      status: 'UNSUPPORTED',
      resolvedVehicle: null,
      confidence: 0.1,
      validationErrors: [
        {
          field: 'vehicle',
          code: 'UNKNOWN_VEHICLE',
          message: '"Toyota Corolla" is not a vehicle we currently offer',
          severity: 'ERROR',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects confidence outside 0..1', () => {
    const result = vehicleDeterminationResultSchema.safeParse({ ...base, confidence: 1.2 });
    expect(result.success).toBe(false);
  });

  it('rejects an ambiguity with a wrong field literal', () => {
    const result = vehicleDeterminationResultSchema.safeParse({
      ...base,
      ambiguities: [{ field: 'pickupDate', code: 'NO_VEHICLE_MENTIONED', message: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown validation error code', () => {
    const result = vehicleDeterminationResultSchema.safeParse({
      ...base,
      validationErrors: [
        { field: 'vehicle', code: 'VEHICLE_ON_FIRE', message: 'x', severity: 'ERROR' },
      ],
    });
    expect(result.success).toBe(false);
  });
});
