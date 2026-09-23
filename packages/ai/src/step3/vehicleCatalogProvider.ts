import type {
  Vehicle,
  VehicleAvailabilityStatusValue,
  VehicleCategoryValue,
} from '@ai-concierge/domain';

/** Lightweight projection used only for matching text against the fleet — never the full record. */
export interface VehicleLexiconEntry {
  id: string;
  make: string;
  model: string;
  category: VehicleCategoryValue;
  active: boolean;
  availabilityStatus: VehicleAvailabilityStatusValue;
}

export interface VehicleAlternativeCriteria {
  category?: VehicleCategoryValue;
  excludeIds?: string[];
  limit?: number;
}

/**
 * Seam between `packages/ai` (pure matching/validation logic, zero
 * DB/network dependency) and the real fleet data ("database is
 * authoritative — never invent inventory"). The concrete Prisma-backed
 * implementation lives in `apps/api` (the composition root that already
 * depends on both `@ai-concierge/ai` and `@ai-concierge/db`), the same
 * layering Step 2 used for `LocationProvider` — except this one is
 * genuinely tenant-scoped (a fleet is per-tenant, unlike Step 2's global
 * Dubai/UAE gazetteer), so every method takes `tenantId` explicitly rather
 * than being baked into a constructor.
 */
export interface VehicleCatalogProvider {
  readonly name: string;
  listLexicon(tenantId: string): Promise<VehicleLexiconEntry[]>;
  findByIds(tenantId: string, ids: string[]): Promise<Vehicle[]>;
  findAlternatives(tenantId: string, criteria: VehicleAlternativeCriteria): Promise<Vehicle[]>;
}

export interface FindAlternativesWithFallbackOptions {
  category?: VehicleCategoryValue;
  excludeIds: string[];
  limit: number;
}

/**
 * Category-scoped first; widens to the general active fleet only when that
 * comes up empty (e.g. the only vehicle in that category is the one just
 * excluded) — never leaves the caller with nothing when a same-category set
 * could plausibly not exist. Shared by Step 3's own resolution fallback
 * (`VehicleCatalogService`) and Step 7's candidate generation
 * (`AlternativeRecommendationOrchestrator`) — both need exactly this policy,
 * so it lives once here rather than twice.
 */
export async function findAlternativesWithFallback(
  provider: VehicleCatalogProvider,
  tenantId: string,
  options: FindAlternativesWithFallbackOptions,
): Promise<Vehicle[]> {
  const scoped = await provider.findAlternatives(tenantId, {
    category: options.category,
    excludeIds: options.excludeIds,
    limit: options.limit,
  });
  if (scoped.length === 0 && options.category !== undefined) {
    return provider.findAlternatives(tenantId, {
      excludeIds: options.excludeIds,
      limit: options.limit,
    });
  }
  return scoped;
}
