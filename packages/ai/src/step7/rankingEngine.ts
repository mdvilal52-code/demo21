import { LuxuryTier, type LuxuryTierValue, type Vehicle } from '@ai-concierge/domain';
import type { EvaluatedCandidate, RankAlternativesResult, RankedCandidate } from './types.js';

const TIER_ORDER: readonly LuxuryTierValue[] = [
  LuxuryTier.PREMIUM,
  LuxuryTier.LUXURY,
  LuxuryTier.ULTRA_LUXURY,
];

function tierIndex(tier: LuxuryTierValue): number {
  return TIER_ORDER.indexOf(tier);
}

/** Rounds to cents — avoids floating-point noise in a persisted/returned price difference. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toRankedCandidate(requested: Vehicle, candidate: EvaluatedCandidate): RankedCandidate {
  const sameCurrency =
    candidate.vehicle.pricingProfile.currency === requested.pricingProfile.currency;
  return {
    vehicle: candidate.vehicle,
    availabilitySource: candidate.outcome.source,
    availabilityCheckedAt: candidate.checkedAt,
    ranking: {
      sameCategory: candidate.vehicle.category === requested.category,
      luxuryTierDelta: Math.abs(
        tierIndex(candidate.vehicle.luxuryTier) - tierIndex(requested.luxuryTier),
      ),
      priceDifference: sameCurrency
        ? round2(candidate.vehicle.pricingProfile.dailyRate - requested.pricingProfile.dailyRate)
        : null,
      currency: sameCurrency ? requested.pricingProfile.currency : null,
      sameBrand: candidate.vehicle.make === requested.make,
    },
  };
}

/**
 * The ladder, in the exact priority order specified: category -> luxury tier ->
 * price -> preference (brand). Availability and customer-constraint filtering
 * already happened before any candidate reaches this comparator (see
 * `rankAlternatives`) — this only orders survivors.
 *
 * Price compares by absolute distance from the requested vehicle's own rate,
 * not by "cheaper wins" — a candidate AED 100 below and one AED 100 above tie
 * on this stage. This is deliberate: ranking by raw signed difference (or
 * "prefer higher price") would let the engine quietly favor the pricier
 * upsell whenever it happened to be the larger candidate set, exactly the
 * "biased recommendation" failure mode the spec calls out. Distance-from-ask
 * has no revenue-direction preference built in.
 *
 * A currency mismatch (priceDifference/currency both null) sorts after every
 * candidate with a real comparison — never fabricated as "cheapest" or
 * "priciest" by guessing, just honestly last on this one axis; it can still
 * win overall on category/tier/brand.
 *
 * Final tiebreak is the candidate's own id — stable and content-free, never a
 * hidden preference for one make/model over another.
 */
function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  if (a.ranking.sameCategory !== b.ranking.sameCategory) {
    return a.ranking.sameCategory ? -1 : 1;
  }
  if (a.ranking.luxuryTierDelta !== b.ranking.luxuryTierDelta) {
    return a.ranking.luxuryTierDelta - b.ranking.luxuryTierDelta;
  }
  const aPrice =
    a.ranking.priceDifference === null ? Infinity : Math.abs(a.ranking.priceDifference);
  const bPrice =
    b.ranking.priceDifference === null ? Infinity : Math.abs(b.ranking.priceDifference);
  if (aPrice !== bPrice) {
    return aPrice - bPrice;
  }
  if (a.ranking.sameBrand !== b.ranking.sameBrand) {
    return a.ranking.sameBrand ? -1 : 1;
  }
  return a.vehicle.id.localeCompare(b.vehicle.id);
}

/**
 * Step 7's deterministic core: rank -> [availability, customer constraints,
 * category, luxury tier, price, preference], exactly the six stages the spec
 * lists, applied as a filter-then-sort ladder (mirrors Step 5's rule-cascade
 * shape). Zero AI/LLM calls — same "AI may explain, never decide" split Step
 * 5 established; `reasonBuilder.ts` turns this function's structured output
 * into the explanatory text.
 *
 * Stage 1 (availability) — "never recommend unavailable inventory as
 * available": only a candidate whose live `AvailabilityProvider` read (passed
 * in already resolved, see step7/orchestrator.ts) confirmed AVAILABLE for the
 * requested dates survives. A candidate that merely looks available in the
 * static catalog (`Vehicle.availabilityStatus`) but isn't for these specific
 * dates is exactly the gap this stage closes — see PHASE-7.md §3 for a fully
 * worked example (the "availability conflict" test case).
 *
 * Stage 2 (customer constraints) — the richest structured "requirement" that
 * Steps 1-4 persist today is the requested vehicle's own capacity, so a
 * qualifying alternative must seat/carry at least as much as what the
 * customer originally asked for (documented limitation: no other structured
 * requirement field exists yet to filter on — see PHASE-7.md §9).
 */
export function rankAlternatives(
  requested: Vehicle,
  evaluated: EvaluatedCandidate[],
): RankAlternativesResult {
  const consideredCount = evaluated.length;

  const available = evaluated.filter((candidate) => candidate.outcome.status === 'AVAILABLE');

  const meetsConstraints = available.filter(
    (candidate) =>
      candidate.vehicle.seats >= requested.seats && candidate.vehicle.luggage >= requested.luggage,
  );

  const qualifying = meetsConstraints
    .map((candidate) => toRankedCandidate(requested, candidate))
    .sort(compareCandidates);

  return { qualifying, consideredCount };
}
