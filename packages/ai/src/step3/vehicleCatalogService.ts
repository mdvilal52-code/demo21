import type { Vehicle } from '@ai-concierge/domain';
import type { VehicleIntentProposal } from './vehicleIntentService.js';
import {
  findAlternativesWithFallback,
  type VehicleCatalogProvider,
  type VehicleLexiconEntry,
} from './vehicleCatalogProvider.js';

export interface VehicleCatalogLookup {
  /** Full records for the proposal's candidate ids that still exist (never soft-deleted). */
  matchedVehicles: Vehicle[];
  /**
   * A small, always-fetched set of genuinely bookable alternatives (active +
   * AVAILABLE, excluding whatever was already matched), scoped to the first
   * candidate's category when one exists. `VehicleValidationService` decides
   * whether/which alternatives to actually surface based on the final
   * status — this service only supplies real data, never a decision.
   */
  fallbackAlternatives: Vehicle[];
}

const FALLBACK_ALTERNATIVES_LIMIT = 5;

/**
 * The one class that talks to the real fleet ("database is authoritative").
 * `VehicleIntentService` and `VehicleValidationService` are pure; this is
 * the seam between them and an injected `VehicleCatalogProvider`.
 */
export class VehicleCatalogService {
  constructor(private readonly provider: VehicleCatalogProvider) {}

  async getLexicon(tenantId: string): Promise<VehicleLexiconEntry[]> {
    return this.provider.listLexicon(tenantId);
  }

  async resolve(tenantId: string, proposal: VehicleIntentProposal): Promise<VehicleCatalogLookup> {
    const ids = proposal.candidates.map((candidate) => candidate.lexiconEntryId);
    const matchedVehicles = ids.length > 0 ? await this.provider.findByIds(tenantId, ids) : [];

    const category = proposal.candidates[0]?.category;
    // A category-scoped search can legitimately come up empty (e.g. the only
    // vehicle in that category is the inactive one just asked about) — widen
    // to the general active fleet rather than leaving the customer with
    // nothing to choose from.
    const fallbackAlternatives = await findAlternativesWithFallback(this.provider, tenantId, {
      category,
      excludeIds: ids,
      limit: FALLBACK_ALTERNATIVES_LIMIT,
    });

    return { matchedVehicles, fallbackAlternatives };
  }
}
