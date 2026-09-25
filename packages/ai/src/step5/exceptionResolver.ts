import {
  EligibilityRiskLevel,
  EligibilityRuleOutcome,
  type EligibilityException,
  type EligibilityExceptionApplied,
  type EligibilityRuleResult,
} from '@ai-concierge/domain';

export interface ExceptionResolution {
  ruleResult: EligibilityRuleResult;
  applied?: EligibilityExceptionApplied;
}

/**
 * Looks up whether a FAILed rule is covered by one of the customer's
 * applicable, tenant-configured exceptions and, if so, applies it — never
 * an in-the-moment decision this engine invents. A LOW-risk exception
 * auto-waives the rule (`WAIVED`); a HIGH-risk one is recorded as matching
 * but never auto-applied (`REQUIRES_REVIEW`) — "High-risk exceptions ->
 * human" — so the overall decision escalates instead of silently passing.
 * A PASS/WAIVED/REQUIRES_REVIEW rule is returned unchanged; only a fresh
 * FAIL is ever eligible for resolution.
 */
export function resolveWithExceptions(
  ruleResult: EligibilityRuleResult,
  exceptions: EligibilityException[],
): ExceptionResolution {
  if (ruleResult.outcome !== EligibilityRuleOutcome.FAIL) {
    return { ruleResult };
  }

  const match = exceptions.find((exception) =>
    exception.waivedCategories.includes(ruleResult.category),
  );
  if (!match) {
    return { ruleResult };
  }

  const autoApplied = match.riskLevel === EligibilityRiskLevel.LOW;
  const resolvedRuleResult: EligibilityRuleResult = {
    ...ruleResult,
    outcome: autoApplied ? EligibilityRuleOutcome.WAIVED : EligibilityRuleOutcome.REQUIRES_REVIEW,
    waivedByExceptionId: match.id,
  };
  const applied: EligibilityExceptionApplied = {
    exceptionId: match.id,
    type: match.type,
    categoriesWaived: match.waivedCategories,
    riskLevel: match.riskLevel,
    autoApplied,
  };

  return { ruleResult: resolvedRuleResult, applied };
}
