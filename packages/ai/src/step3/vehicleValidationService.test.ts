import type { Vehicle } from '@ai-concierge/domain';
import { describe, expect, it } from 'vitest';
import type { VehicleCatalogLookup } from './vehicleCatalogService.js';
import type { VehicleIntentProposal, VehicleMentionCandidate } from './vehicleIntentService.js';
import { VehicleValidationService } from './vehicleValidationService.js';

const URUS_ID = '11111111-1111-1111-1111-111111111111';
const HURACAN_ID = '22222222-2222-2222-2222-222222222222';
const RANGE_ROVER_ID = '33333333-3333-3333-3333-333333333333';
const BENTLEY_ID = '44444444-4444-4444-4444-444444444444';
const CULLINAN_ID = '55555555-5555-5555-5555-555555555555';

function makeVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: URUS_ID,
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
    ...overrides,
  };
}

function candidate(overrides: Partial<VehicleMentionCandidate> = {}): VehicleMentionCandidate {
  return {
    lexiconEntryId: URUS_ID,
    make: 'Lamborghini',
    model: 'Urus',
    category: 'SUV',
    matchType: 'EXACT_MODEL',
    matchedText: 'Lamborghini Urus',
    similarity: 1,
    ...overrides,
  };
}

function makeService(): VehicleValidationService {
  return new VehicleValidationService();
}

describe('VehicleValidationService', () => {
  it('resolves cleanly for a single exact, active, available match', () => {
    const urus = makeVehicle();
    const proposal: VehicleIntentProposal = { candidates: [candidate()], rawMention: null };
    const lookup: VehicleCatalogLookup = { matchedVehicles: [urus], fallbackAlternatives: [] };

    const result = makeService().validate({ proposal, lookup, promptInjectionDetected: false });
    expect(result.status).toBe('RESOLVED');
    expect(result.resolvedVehicle).toEqual(urus);
    expect(result.validationErrors).toEqual([]);
    expect(result.ambiguities).toEqual([]);
    expect(result.alternatives).toEqual([]);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('needs clarification with alternatives when a brand has multiple matches', () => {
    const urus = makeVehicle();
    const huracan = makeVehicle({ id: HURACAN_ID, model: 'Huracan', category: 'SPORTS' });
    const proposal: VehicleIntentProposal = {
      candidates: [
        candidate({ matchType: 'BRAND_ONLY', matchedText: 'Lamborghini' }),
        candidate({
          lexiconEntryId: HURACAN_ID,
          model: 'Huracan',
          category: 'SPORTS',
          matchType: 'BRAND_ONLY',
          matchedText: 'Lamborghini',
        }),
      ],
      rawMention: null,
    };
    const lookup: VehicleCatalogLookup = {
      matchedVehicles: [urus, huracan],
      fallbackAlternatives: [],
    };

    const result = makeService().validate({ proposal, lookup, promptInjectionDetected: false });
    expect(result.status).toBe('NEEDS_CLARIFICATION');
    expect(result.resolvedVehicle).toBeNull();
    expect(result.ambiguities).toEqual([
      expect.objectContaining({ code: 'BRAND_ONLY_MULTIPLE_MATCHES' }),
    ]);
    expect(result.alternatives).toEqual([urus, huracan]);
  });

  it('needs clarification with alternatives when a category has multiple matches', () => {
    const urus = makeVehicle();
    const rangeRover = makeVehicle({
      id: RANGE_ROVER_ID,
      make: 'Land Rover',
      model: 'Range Rover',
    });
    const proposal: VehicleIntentProposal = {
      candidates: [
        candidate({ matchType: 'CATEGORY_ONLY', matchedText: 'SUV' }),
        candidate({
          lexiconEntryId: RANGE_ROVER_ID,
          make: 'Land Rover',
          model: 'Range Rover',
          matchType: 'CATEGORY_ONLY',
          matchedText: 'SUV',
        }),
      ],
      rawMention: null,
    };
    const lookup: VehicleCatalogLookup = {
      matchedVehicles: [urus, rangeRover],
      fallbackAlternatives: [],
    };

    const result = makeService().validate({ proposal, lookup, promptInjectionDetected: false });
    expect(result.status).toBe('NEEDS_CLARIFICATION');
    expect(result.ambiguities).toEqual([
      expect.objectContaining({ code: 'CATEGORY_ONLY_MULTIPLE_MATCHES' }),
    ]);
    expect(result.alternatives).toEqual([urus, rangeRover]);
  });

  it('needs clarification with generic alternatives when no vehicle was mentioned at all', () => {
    const urus = makeVehicle();
    const proposal: VehicleIntentProposal = { candidates: [], rawMention: null };
    const lookup: VehicleCatalogLookup = { matchedVehicles: [], fallbackAlternatives: [urus] };

    const result = makeService().validate({ proposal, lookup, promptInjectionDetected: false });
    expect(result.status).toBe('NEEDS_CLARIFICATION');
    expect(result.ambiguities).toEqual([expect.objectContaining({ code: 'NO_VEHICLE_MENTIONED' })]);
    expect(result.alternatives).toEqual([urus]);
  });

  it('is unsupported with alternatives when the mentioned vehicle is not in the fleet at all', () => {
    const urus = makeVehicle();
    const proposal: VehicleIntentProposal = { candidates: [], rawMention: 'Toyota Corolla' };
    const lookup: VehicleCatalogLookup = { matchedVehicles: [], fallbackAlternatives: [urus] };

    const result = makeService().validate({ proposal, lookup, promptInjectionDetected: false });
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.resolvedVehicle).toBeNull();
    expect(result.validationErrors).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_VEHICLE',
        message: expect.stringContaining('Toyota Corolla'),
        severity: 'ERROR',
      }),
    ]);
    expect(result.alternatives).toEqual([urus]);
  });

  it('is unsupported when the exactly-named vehicle exists but is inactive', () => {
    const bentley = makeVehicle({
      id: BENTLEY_ID,
      make: 'Bentley',
      model: 'Continental',
      active: false,
    });
    const rangeRover = makeVehicle({
      id: RANGE_ROVER_ID,
      make: 'Land Rover',
      model: 'Range Rover',
    });
    const proposal: VehicleIntentProposal = {
      candidates: [
        candidate({ lexiconEntryId: BENTLEY_ID, make: 'Bentley', model: 'Continental' }),
      ],
      rawMention: null,
    };
    const lookup: VehicleCatalogLookup = {
      matchedVehicles: [bentley],
      fallbackAlternatives: [rangeRover],
    };

    const result = makeService().validate({ proposal, lookup, promptInjectionDetected: false });
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.resolvedVehicle).toBeNull();
    expect(result.validationErrors).toEqual([
      expect.objectContaining({ code: 'VEHICLE_INACTIVE', severity: 'ERROR' }),
    ]);
    expect(result.alternatives).toEqual([rangeRover]);
  });

  it('is unsupported when the exactly-named vehicle exists but is under maintenance', () => {
    const cullinan = makeVehicle({
      id: CULLINAN_ID,
      make: 'Rolls-Royce',
      model: 'Cullinan',
      availabilityStatus: 'MAINTENANCE',
    });
    const proposal: VehicleIntentProposal = {
      candidates: [
        candidate({ lexiconEntryId: CULLINAN_ID, make: 'Rolls-Royce', model: 'Cullinan' }),
      ],
      rawMention: null,
    };
    const lookup: VehicleCatalogLookup = { matchedVehicles: [cullinan], fallbackAlternatives: [] };

    const result = makeService().validate({ proposal, lookup, promptInjectionDetected: false });
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.validationErrors).toEqual([
      expect.objectContaining({ code: 'VEHICLE_UNAVAILABLE', severity: 'ERROR' }),
    ]);
  });

  it('treats a candidate missing from the catalog lookup (e.g. deleted mid-flight) as unknown', () => {
    const proposal: VehicleIntentProposal = { candidates: [candidate()], rawMention: null };
    const lookup: VehicleCatalogLookup = { matchedVehicles: [], fallbackAlternatives: [] };

    const result = makeService().validate({ proposal, lookup, promptInjectionDetected: false });
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.validationErrors[0]?.code).toBe('UNKNOWN_VEHICLE');
  });

  it('lowers confidence proportionally to the fuzzy-match similarity score', () => {
    const urus = makeVehicle();
    const proposal: VehicleIntentProposal = {
      candidates: [candidate({ matchType: 'FUZZY_MATCH', similarity: 0.8 })],
      rawMention: null,
    };
    const lookup: VehicleCatalogLookup = { matchedVehicles: [urus], fallbackAlternatives: [] };

    const result = makeService().validate({ proposal, lookup, promptInjectionDetected: false });
    expect(result.status).toBe('RESOLVED');
    expect(result.confidence).toBeLessThan(0.9);
  });

  it('lowers confidence for an imprecise (brand/category-only) match even when resolved', () => {
    const urus = makeVehicle();
    const exactProposal: VehicleIntentProposal = { candidates: [candidate()], rawMention: null };
    const brandProposal: VehicleIntentProposal = {
      candidates: [candidate({ matchType: 'BRAND_ONLY' })],
      rawMention: null,
    };
    const lookup: VehicleCatalogLookup = { matchedVehicles: [urus], fallbackAlternatives: [] };

    const exactResult = makeService().validate({
      proposal: exactProposal,
      lookup,
      promptInjectionDetected: false,
    });
    const brandResult = makeService().validate({
      proposal: brandProposal,
      lookup,
      promptInjectionDetected: false,
    });
    expect(brandResult.confidence).toBeLessThan(exactResult.confidence);
  });

  it('passes the promptInjectionDetected flag through untouched', () => {
    const proposal: VehicleIntentProposal = { candidates: [], rawMention: 'Bugatti Chiron' };
    const lookup: VehicleCatalogLookup = { matchedVehicles: [], fallbackAlternatives: [] };

    const result = makeService().validate({ proposal, lookup, promptInjectionDetected: true });
    expect(result.flags.promptInjectionDetected).toBe(true);
    // Never fabricates the mentioned vehicle even under injection.
    expect(result.resolvedVehicle).toBeNull();
    expect(result.alternatives.some((v) => v.model === 'Chiron')).toBe(false);
  });
});
