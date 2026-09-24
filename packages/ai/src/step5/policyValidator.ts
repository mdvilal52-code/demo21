import {
  PolicyConflictCode,
  type EligibilityPolicyRules,
  type PolicyConflict,
} from '@ai-concierge/domain';

/**
 * A tenant's own policy configuration can be internally inconsistent (a
 * misconfigured nationality list, a tier minimum age that's *looser* than
 * the global one). This is a structural check on the policy itself, run
 * before any rule evaluates against it — never an attempt to guess which
 * half of a contradictory config the tenant "really meant". Any conflict
 * found means the orchestrator fails safe to `NEEDS_HUMAN_REVIEW` instead of
 * evaluating rules against configuration nobody can be sure is correct
 * ("Never allow AI to override policy" extends to never letting this engine
 * silently resolve an ambiguity the tenant's own config created).
 */
export function validateEligibilityPolicy(rules: EligibilityPolicyRules): PolicyConflict[] {
  const conflicts: PolicyConflict[] = [];

  const { blockedNationalities, allowedNationalitiesOnly } = rules.nationalityRules;
  const overlap = blockedNationalities.filter((code) => allowedNationalitiesOnly.includes(code));
  if (overlap.length > 0) {
    conflicts.push({
      code: PolicyConflictCode.NATIONALITY_IN_BOTH_LISTS,
      message: `Nationality code(s) ${overlap.join(', ')} appear in both the blocked and allowed-only lists.`,
    });
  }

  for (const [tier, tierMinAge] of Object.entries(rules.minAgeByLuxuryTier)) {
    if (tierMinAge < rules.minAge) {
      conflicts.push({
        code: PolicyConflictCode.TIER_MIN_AGE_BELOW_GLOBAL,
        message: `${tier} minimum age (${tierMinAge}) is below the global minimum age (${rules.minAge}).`,
      });
    }
  }

  return conflicts;
}
