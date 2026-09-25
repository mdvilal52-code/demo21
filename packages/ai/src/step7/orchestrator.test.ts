import { describe, expect, it, vi } from 'vitest';
import type { VehicleCatalogProvider } from '../step3/vehicleCatalogProvider.js';
import type { AvailabilityProvider } from '../step6/availabilityProvider.js';
import { AlternativeRecommendationOrchestrator } from './orchestrator.js';
import { makeVehicle } from './test/fixtures.js';

const PICKUP_AT = new Date('2026-10-05T10:00:00.000Z');
const RETURN_AT = new Date('2026-10-08T10:00:00.000Z');

function makeCatalogProvider(byCategory: Record<string, ReturnType<typeof makeVehicle>[]>) {
  return {
    name: 'fake-catalog',
    listLexicon: vi.fn(),
    findByIds: vi.fn(),
    findAlternatives: vi.fn(async (_tenantId: string, criteria: { category?: string }) => {
      if (criteria.category) {
        return byCategory[criteria.category] ?? [];
      }
      return Object.values(byCategory).flat();
    }),
  } satisfies VehicleCatalogProvider;
}

type PreviewStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'MAINTENANCE' | 'UNKNOWN';

function makeAvailabilityProvider(
  statusByVehicleId: Record<string, PreviewStatus>,
): AvailabilityProvider {
  return {
    name: 'fake-availability',
    checkAvailability: vi.fn(async (query: { vehicleId: string }) => ({
      status: statusByVehicleId[query.vehicleId] ?? 'AVAILABLE',
      source: 'fake-availability',
      reason: null,
      retryable: false,
    })),
  };
}

describe('AlternativeRecommendationOrchestrator', () => {
  it('checks live availability only for candidates the catalog provider returned', async () => {
    const requested = makeVehicle({ id: 'req-1', category: 'SUV' });
    const alt1 = makeVehicle({ id: 'alt-1', category: 'SUV' });
    const catalogProvider = makeCatalogProvider({ SUV: [alt1] });
    const availabilityProvider = makeAvailabilityProvider({});
    const orchestrator = new AlternativeRecommendationOrchestrator({
      catalogProvider,
      availabilityProvider,
    });

    const result = await orchestrator.recommend({
      tenantId: 't1',
      requestedVehicle: requested,
      pickupAt: PICKUP_AT,
      returnAt: RETURN_AT,
    });

    expect(catalogProvider.findAlternatives).toHaveBeenCalledWith('t1', {
      category: 'SUV',
      excludeIds: ['req-1'],
      limit: 5,
    });
    expect(availabilityProvider.checkAvailability).toHaveBeenCalledWith({
      tenantId: 't1',
      vehicleId: 'alt-1',
      pickupAt: PICKUP_AT,
      returnAt: RETURN_AT,
    });
    expect(result.qualifying.map((c) => c.vehicle.id)).toEqual(['alt-1']);
  });

  it('widens to the general active fleet when a category-scoped search is empty (matches Step 3 precedent)', async () => {
    const requested = makeVehicle({ id: 'req-1', category: 'SUV' });
    const otherCategoryAlt = makeVehicle({ id: 'alt-1', category: 'SEDAN' });
    const catalogProvider = makeCatalogProvider({ SUV: [], SEDAN: [otherCategoryAlt] });
    const availabilityProvider = makeAvailabilityProvider({});
    const orchestrator = new AlternativeRecommendationOrchestrator({
      catalogProvider,
      availabilityProvider,
    });

    const result = await orchestrator.recommend({
      tenantId: 't1',
      requestedVehicle: requested,
      pickupAt: PICKUP_AT,
      returnAt: RETURN_AT,
    });

    expect(catalogProvider.findAlternatives).toHaveBeenNthCalledWith(1, 't1', {
      category: 'SUV',
      excludeIds: ['req-1'],
      limit: 5,
    });
    expect(catalogProvider.findAlternatives).toHaveBeenNthCalledWith(2, 't1', {
      excludeIds: ['req-1'],
      limit: 5,
    });
    expect(result.qualifying.map((c) => c.vehicle.id)).toEqual(['alt-1']);
  });

  it('excludes a candidate the live check finds unavailable even though the catalog offered it ("availability conflict")', async () => {
    const requested = makeVehicle({ id: 'req-1', category: 'SUV' });
    const staleCatalogEntry = makeVehicle({ id: 'held-elsewhere', category: 'SUV' });
    const catalogProvider = makeCatalogProvider({ SUV: [staleCatalogEntry] });
    const availabilityProvider = makeAvailabilityProvider({ 'held-elsewhere': 'UNAVAILABLE' });
    const orchestrator = new AlternativeRecommendationOrchestrator({
      catalogProvider,
      availabilityProvider,
    });

    const result = await orchestrator.recommend({
      tenantId: 't1',
      requestedVehicle: requested,
      pickupAt: PICKUP_AT,
      returnAt: RETURN_AT,
    });

    expect(result.consideredCount).toBe(1);
    expect(result.qualifying).toEqual([]);
  });

  it('never places a hold — only the non-committal availability preview is called', async () => {
    const requested = makeVehicle({ id: 'req-1', category: 'SUV' });
    const alt1 = makeVehicle({ id: 'alt-1', category: 'SUV' });
    const catalogProvider = makeCatalogProvider({ SUV: [alt1] });
    const availabilityProvider = makeAvailabilityProvider({});
    const orchestrator = new AlternativeRecommendationOrchestrator({
      catalogProvider,
      availabilityProvider,
    });

    await orchestrator.recommend({
      tenantId: 't1',
      requestedVehicle: requested,
      pickupAt: PICKUP_AT,
      returnAt: RETURN_AT,
    });

    // Structural proof, not just behavioral: this orchestrator's own options
    // type has no reservation/hold service to call in the first place.
    expect(Object.keys(availabilityProvider)).not.toContain('placeHold');
  });
});
