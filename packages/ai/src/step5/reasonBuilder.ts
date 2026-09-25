import {
  EligibilityDecisionStatus,
  EligibilityRuleOutcome,
  type EligibilityDecisionStatusValue,
  type EligibilityExceptionApplied,
  type EligibilityRuleResult,
} from '@ai-concierge/domain';

/** A single deterministic, template-based summary — never AI-generated free text (see CLAUDE.md). */
export function buildEligibilityReason(
  status: EligibilityDecisionStatusValue,
  ruleResults: EligibilityRuleResult[],
  exceptionsApplied: EligibilityExceptionApplied[],
): string {
  if (status === EligibilityDecisionStatus.ELIGIBLE) {
    const waived = exceptionsApplied.filter((exception) => exception.autoApplied);
    if (waived.length > 0) {
      return `Eligible. ${waived.length} exception(s) applied: ${waived.map((e) => e.type).join(', ')}.`;
    }
    return 'Eligible. All checks passed.';
  }

  if (status === EligibilityDecisionStatus.NEEDS_HUMAN_REVIEW) {
    const pending = exceptionsApplied.filter((exception) => !exception.autoApplied);
    if (pending.length > 0) {
      return `Needs human review: ${pending.length} high-risk exception(s) pending approval (${pending
        .map((e) => e.type)
        .join(', ')}).`;
    }
    return 'Needs human review: this tenant’s eligibility policy configuration has an internal conflict.';
  }

  const failed = ruleResults.filter((result) => result.outcome === EligibilityRuleOutcome.FAIL);
  return `Ineligible: ${failed.map((result) => result.message).join(' ')}`;
}
