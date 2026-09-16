import type { Vehicle } from '@ai-concierge/domain';
import { describe, expect, it, vi } from 'vitest';
import type {
  VehicleAlternativeCriteria,
  VehicleCatalogProvider,
  VehicleLexiconEntry,
} from './vehicleCatalogProvider.js';
import { VehicleCatalogService } from './vehicleCatalogService.js';
import type { VehicleIntentProposal } from './vehicleIntentService.js';

function makeVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: 'urus-id',
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

class FakeProvider implements VehicleCatalogProvider {
  readonly name = 'fake';
  listLexiconCalls: string[] = [];
  findByIdsCalls: Array<{ tenantId: string; ids: string[] }> = [];
  findAlternativesCalls: Array<{ tenantId: string; criteria: VehicleAlternativeCriteria }> = [];

  constructor(
    private readonly lexicon: VehicleLexiconEntry[],
    private readonly vehiclesById: Record<string, Vehicle>,
    private readonly alternatives: Vehicle[],
  ) {}

  async listLexicon(tenantId: string): Promise<VehicleLexiconEntry[]> {
    this.listLexiconCalls.push(tenantId);
    return this.lexicon;
  }

  async findByIds(tenantId: string, ids: string[]): Promise<Vehicle[]> {
    this.findByIdsCalls.push({ tenantId, ids });
    return ids.map((id) => this.vehiclesById[id]).filter((v): v is Vehicle => v !== undefined);
  }

  async findAlternatives(
    tenantId: string,
    criteria: VehicleAlternativeCriteria,
  ): Promise<Vehicle[]> {
    this.findAlternativesCalls.push({ tenantId, criteria });
    return this.alternatives.filter((v) => !criteria.category || v.category === criteria.category);
  }
}

describe('VehicleCatalogService', () => {
  it('getLexicon delegates to the provider for the given tenant', async () => {
    const provider = new FakeProvider([], {}, []);
    const service = new VehicleCatalogService(provider);
    await service.getLexicon('tenant-1');
    expect(provider.listLexiconCalls).toEqual(['tenant-1']);
  });

  it('resolve fetches full records only for the proposal candidate ids', async () => {
    const urus = makeVehicle();
    const provider = new FakeProvider([], { 'urus-id': urus }, []);
    const service = new VehicleCatalogService(provider);
    const proposal: VehicleIntentProposal = {
      candidates: [
        {
          lexiconEntryId: 'urus-id',
          make: 'Lamborghini',
          model: 'Urus',
          category: 'SUV',
          matchType: 'EXACT_MODEL',
          matchedText: 'Lamborghini Urus',
          similarity: 1,
        },
      ],
      rawMention: null,
    };

    const lookup = await service.resolve('tenant-1', proposal);
    expect(lookup.matchedVehicles).toEqual([urus]);
    expect(provider.findByIdsCalls).toEqual([{ tenantId: 'tenant-1', ids: ['urus-id'] }]);
  });

  it('resolve fetches zero matched vehicles (and skips findByIds) when there are no candidates', async () => {
    const provider = new FakeProvider([], {}, []);
    const findByIdsSpy = vi.spyOn(provider, 'findByIds');
    const service = new VehicleCatalogService(provider);

    const lookup = await service.resolve('tenant-1', { candidates: [], rawMention: 'spaceship' });
    expect(lookup.matchedVehicles).toEqual([]);
    expect(findByIdsSpy).not.toHaveBeenCalled();
  });

  it('resolve always fetches fallback alternatives, scoped to the first candidate category and excluding matched ids', async () => {
    const rangeRover = makeVehicle({
      id: 'range-rover-id',
      make: 'Land Rover',
      model: 'Range Rover',
    });
    const provider = new FakeProvider([], {}, [rangeRover]);
    const service = new VehicleCatalogService(provider);
    const proposal: VehicleIntentProposal = {
      candidates: [
        {
          lexiconEntryId: 'urus-id',
          make: 'Lamborghini',
          model: 'Urus',
          category: 'SUV',
          matchType: 'CATEGORY_ONLY',
          matchedText: 'SUV',
          similarity: 1,
        },
      ],
      rawMention: null,
    };

    const lookup = await service.resolve('tenant-1', proposal);
    expect(lookup.fallbackAlternatives).toEqual([rangeRover]);
    expect(provider.findAlternativesCalls).toEqual([
      { tenantId: 'tenant-1', criteria: { category: 'SUV', excludeIds: ['urus-id'], limit: 5 } },
    ]);
  });

  it('widens to the general active fleet when the category-scoped fallback search is empty', async () => {
    const sedan = makeVehicle({ id: 'sedan-id', category: 'SEDAN' });
    // Only a SEDAN exists as a real alternative, but the candidate that
    // failed was a COUPE — the category-scoped search alone would starve
    // the customer of any suggestion at all.
    const provider = new FakeProvider([], {}, [sedan]);
    const service = new VehicleCatalogService(provider);
    const proposal: VehicleIntentProposal = {
      candidates: [
        {
          lexiconEntryId: 'coupe-id',
          make: 'Bentley',
          model: 'Continental',
          category: 'COUPE',
          matchType: 'EXACT_MODEL',
          matchedText: 'Bentley Continental',
          similarity: 1,
        },
      ],
      rawMention: null,
    };

    const lookup = await service.resolve('tenant-1', proposal);
    expect(lookup.fallbackAlternatives).toEqual([sedan]);
    expect(provider.findAlternativesCalls).toHaveLength(2);
    expect(provider.findAlternativesCalls[0]?.criteria.category).toBe('COUPE');
    expect(provider.findAlternativesCalls[1]?.criteria.category).toBeUndefined();
  });

  it('does not widen when there genuinely were no candidates to begin with', async () => {
    const provider = new FakeProvider([], {}, []);
    const service = new VehicleCatalogService(provider);

    await service.resolve('tenant-1', { candidates: [], rawMention: null });
    expect(provider.findAlternativesCalls).toHaveLength(1);
  });

  it('resolve requests unfiltered fallback alternatives when nothing was mentioned', async () => {
    const provider = new FakeProvider([], {}, []);
    const service = new VehicleCatalogService(provider);

    await service.resolve('tenant-1', { candidates: [], rawMention: null });
    expect(provider.findAlternativesCalls).toEqual([
      { tenantId: 'tenant-1', criteria: { category: undefined, excludeIds: [], limit: 5 } },
    ]);
  });
});
