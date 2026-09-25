import type { Vehicle } from '@ai-concierge/domain';
import type { RankedCandidate } from './types.js';

/**
 * Deterministic, template-based summary of why a candidate ranked where it
 * did — names every ladder stage that actually distinguished it, never a
 * generic "good match". Same "AI may explain, must never decide" posture as
 * Step 5's `buildEligibilityReason`: this is not a live LLM call over
 * untrusted output, just formatting of the ranking engine's own structured
 * result.
 */
export function buildAlternativeReason(requested: Vehicle, candidate: RankedCandidate): string {
  const notes: string[] = [];

  notes.push(
    candidate.ranking.sameCategory
      ? `same category (${candidate.vehicle.category})`
      : `different category (${candidate.vehicle.category} vs. requested ${requested.category})`,
  );

  notes.push(
    candidate.ranking.luxuryTierDelta === 0
      ? `same luxury tier (${candidate.vehicle.luxuryTier})`
      : `luxury tier ${candidate.vehicle.luxuryTier} (${candidate.ranking.luxuryTierDelta} tier(s) from requested ${requested.luxuryTier})`,
  );

  if (candidate.ranking.priceDifference === null) {
    notes.push('price not directly comparable (different currency)');
  } else {
    const diff = candidate.ranking.priceDifference;
    const direction = diff === 0 ? 'same price as' : diff > 0 ? 'more than' : 'less than';
    notes.push(
      diff === 0
        ? `same daily rate as requested (${candidate.ranking.currency} ${requested.pricingProfile.dailyRate})`
        : `${candidate.ranking.currency} ${Math.abs(diff)}/day ${direction} requested`,
    );
  }

  if (candidate.ranking.sameBrand) {
    notes.push(`same make (${candidate.vehicle.make})`);
  }

  return `${candidate.vehicle.make} ${candidate.vehicle.model}: ${notes.join(', ')}.`;
}
