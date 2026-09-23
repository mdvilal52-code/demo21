import {
  EligibilityDecisionStatus,
  EligibilityRuleOutcome,
  eligibilityDecisionResultSchema,
  type EligibilityDecisionResult,
  type EligibilityException,
  type EligibilityExceptionApplied,
  type EligibilityPolicy,
  type EligibilityRuleResult,
} from '@ai-concierge/domain';
import { resolveWithExceptions } from './exceptionResolver.js';
import { validateEligibilityPolicy } from './policyValidator.js';
import { buildEligibilityReason } from './reasonBuilder.js';
import { ELIGIBILITY_RULES } from './rules/index.js';
import type { EligibilityCheckContext } from './types.js';

const MODEL_METADATA = {
  engine: 'eligibility-engine-v1',
  version: '0.1.0',
  deterministic: true,
} as const;

/**
 * Step 5 — Eligibility (MASTER-PLAN.md `ELIGIBILITY_CHECK`, "SYS" owner).
 * Unlike Steps 1-4, there is no AI proposal stage at all: this orchestrator
 * runs every configured `EligibilityRule` against the tenant's active
 * `EligibilityPolicy`, deterministically applies any matching
 * `EligibilityException`, and returns an auditable `EligibilityDecisionResult`
 * — `ELIGIBLE` / `INELIGIBLE` / `NEEDS_HUMAN_REVIEW`. Nothing here is an LLM
 * output and nothing downstream may override it ("Never allow AI to
 * override policy").
 */
export class EligibilityOrchestrator {
  evaluate(
    context: EligibilityCheckContext,
    policy: EligibilityPolicy,
    exceptions: EligibilityException[],
  ): EligibilityDecisionResult {
    const policyConflicts = validateEligibilityPolicy(policy.rules);
    if (policyConflicts.length > 0) {
      return eligibilityDecisionResultSchema.parse({
        status: EligibilityDecisionStatus.NEEDS_HUMAN_REVIEW,
        ruleResults: [],
        exceptionsApplied: [],
        policyConflicts,
        reason: buildEligibilityReason(EligibilityDecisionStatus.NEEDS_HUMAN_REVIEW, [], []),
        policyId: policy.id,
        policyVersion: policy.version,
        flags: { policyConflictDetected: true },
        modelMetadata: MODEL_METADATA,
      });
    }

    const ruleResults: EligibilityRuleResult[] = [];
    const exceptionsApplied: EligibilityExceptionApplied[] = [];

    for (const rule of ELIGIBILITY_RULES) {
      const verdict = rule.evaluate(context, policy.rules);
      let ruleResult: EligibilityRuleResult = {
        ruleId: rule.id,
        category: rule.category,
        outcome: verdict.outcome,
        message: verdict.message,
      };

      const resolution = resolveWithExceptions(ruleResult, exceptions);
      ruleResult = resolution.ruleResult;
      if (resolution.applied) {
        exceptionsApplied.push(resolution.applied);
      }

      ruleResults.push(ruleResult);
    }

    const hasUnwaivedFailure = ruleResults.some(
      (result) => result.outcome === EligibilityRuleOutcome.FAIL,
    );
    const hasPendingHighRiskException = exceptionsApplied.some(
      (exception) => !exception.autoApplied,
    );

    const status = hasUnwaivedFailure
      ? EligibilityDecisionStatus.INELIGIBLE
      : hasPendingHighRiskException
        ? EligibilityDecisionStatus.NEEDS_HUMAN_REVIEW
        : EligibilityDecisionStatus.ELIGIBLE;

    return eligibilityDecisionResultSchema.parse({
      status,
      ruleResults,
      exceptionsApplied,
      policyConflicts: [],
      reason: buildEligibilityReason(status, ruleResults, exceptionsApplied),
      policyId: policy.id,
      policyVersion: policy.version,
      flags: { policyConflictDetected: false },
      modelMetadata: MODEL_METADATA,
    });
  }
}
