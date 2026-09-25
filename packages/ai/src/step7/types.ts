import type { Vehicle } from '@ai-concierge/domain';
import type { AvailabilityCheckOutcome } from '../step6/availabilityProvider.js';

/** A candidate vehicle plus the live (preview-only) availability read taken for it. */
export interface EvaluatedCandidate {
  vehicle: Vehicle;
  outcome: AvailabilityCheckOutcome;
  checkedAt: Date;
}

/**
 * Every ladder stage's raw finding for one qualifying candidate — data, not
 * text; `reasonBuilder.ts` turns this into the human-readable `reason`. Kept
 * separate from that text the same way Step 5's `EligibilityRuleResult[]` is
 * separate from its `reasonBuilder`.
 */
export interface RankingStageResult {
  sameCategory: boolean;
  luxuryTierDelta: number;
  /** null when the candidate quotes a different currency than the requested vehicle — never a guessed/converted figure. */
  priceDifference: number | null;
  currency: string | null;
  sameBrand: boolean;
}

export interface RankedCandidate {
  vehicle: Vehicle;
  availabilitySource: string;
  availabilityCheckedAt: Date;
  ranking: RankingStageResult;
}

export interface RankAlternativesResult {
  /** Best-first; already filtered to real-time-available, constraint-satisfying candidates only. */
  qualifying: RankedCandidate[];
  /** Candidates evaluated before any filter — for audit/transparency, not a promise any qualified. */
  consideredCount: number;
}
