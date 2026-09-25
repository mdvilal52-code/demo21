import type { Vehicle } from '@ai-concierge/domain';
import {
  findAlternativesWithFallback,
  type VehicleCatalogProvider,
} from '../step3/vehicleCatalogProvider.js';
import type { AvailabilityProvider } from '../step6/availabilityProvider.js';
import { rankAlternatives } from './rankingEngine.js';
import type { EvaluatedCandidate, RankAlternativesResult } from './types.js';

/** Matches Step 3's own `FALLBACK_ALTERNATIVES_LIMIT` precedent — a small, always-manageable candidate set. */
const CANDIDATE_LIMIT = 5;

export interface AlternativeRecommendationOrchestratorOptions {
  catalogProvider: VehicleCatalogProvider;
  availabilityProvider: AvailabilityProvider;
}

export interface RecommendAlternativesInput {
  tenantId: string;
  requestedVehicle: Vehicle;
  pickupAt: Date;
  returnAt: Date;
}

/**
 * Step 7 — Alternatives (MASTER-PLAN.md journey Step 7, `OFFERING_ALTERNATIVES`).
 * Deliberately reuses two seams earlier phases already built for exactly this
 * purpose rather than inventing new ones:
 *
 * - `VehicleCatalogProvider` (Step 3) for candidate generation — "database is
 *   authoritative, never invent inventory" — including its own "widen to the
 *   general active fleet when a category-scoped search is empty" precedent
 *   (`VehicleCatalogService`), reproduced here identically.
 * - `AvailabilityProvider` (Step 6) for a non-committal per-candidate
 *   availability preview — the exact seam Phase 6's own docs named as "what
 *   journey Step 7 will need" and built untested-in-production for that
 *   reason. Never `ReservationLockService.placeHold`: this step must never
 *   place a hold against a candidate the customer hasn't chosen yet.
 *
 * Zero AI/LLM calls in this path — `rankAlternatives` is a pure, deterministic
 * function of its inputs; only `reasonBuilder.ts`, one layer up, turns its
 * output into explanatory text.
 */
export class AlternativeRecommendationOrchestrator {
  constructor(private readonly options: AlternativeRecommendationOrchestratorOptions) {}

  async recommend(input: RecommendAlternativesInput): Promise<RankAlternativesResult> {
    const excludeIds = [input.requestedVehicle.id];
    const candidates = await findAlternativesWithFallback(
      this.options.catalogProvider,
      input.tenantId,
      { category: input.requestedVehicle.category, excludeIds, limit: CANDIDATE_LIMIT },
    );

    const evaluated: EvaluatedCandidate[] = await Promise.all(
      candidates.map(async (vehicle) => {
        const checkedAt = new Date();
        const outcome = await this.options.availabilityProvider.checkAvailability({
          tenantId: input.tenantId,
          vehicleId: vehicle.id,
          pickupAt: input.pickupAt,
          returnAt: input.returnAt,
        });
        return { vehicle, outcome, checkedAt };
      }),
    );

    return rankAlternatives(input.requestedVehicle, evaluated);
  }
}
