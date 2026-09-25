import {
  EligibilityDecisionStatus,
  EscalationReason,
  EscalationTier,
  InventoryStatus,
  MissingInfoStatus,
  QuoteStatus,
  type EligibilityDecisionStatusValue,
  type EscalationReasonValue,
  type EscalationTierValue,
  type InventoryStatusValue,
  type MissingInfoStatusValue,
  type QuoteStatusValue,
} from '@ai-concierge/domain';

export interface EscalationDecision {
  tier: EscalationTierValue;
  reason: EscalationReasonValue;
  detail: string;
}

/**
 * Pure "does this Step 1-8 outcome need a human, and at what tier" mapping —
 * the project brief's "AI kaam nahi kar paye toh human worker ko [alert]
 * kar sake" requirement, made concrete and testable. Every branch reads an
 * already-computed status from a step that has already run (never
 * re-evaluates the step itself), the same "propose vs. decide" separation
 * every orchestrator in this codebase keeps. `null` means no escalation is
 * warranted — the caller (journeyService.ts) proceeds normally.
 *
 * Tiers mirror MASTER-PLAN.md §4 exactly: eligibility exceptions and quote
 * pricing review are T3 (Manager — pricing/exception authority); a fleet
 * provider failure is T2 (Ops — an operational fix, not a policy call); a
 * customer who never completes their booking info despite repeated asks
 * also lands with Ops (T2) rather than expiring silently.
 */

const MISSING_INFO_STALL_THRESHOLD = 3;

export function decideEligibilityEscalation(
  status: EligibilityDecisionStatusValue,
  reason: string,
): EscalationDecision | null {
  if (status !== EligibilityDecisionStatus.NEEDS_HUMAN_REVIEW) {
    return null;
  }
  return {
    tier: EscalationTier.T3,
    reason: EscalationReason.ELIGIBILITY_NEEDS_REVIEW,
    detail: reason,
  };
}

export function decideAvailabilityEscalation(
  status: InventoryStatusValue,
  retryable: boolean,
  reason: string | null,
): EscalationDecision | null {
  if (status !== InventoryStatus.UNKNOWN || !retryable) {
    return null;
  }
  return {
    tier: EscalationTier.T2,
    reason: EscalationReason.AVAILABILITY_PROVIDER_FAILURE,
    detail: reason ?? 'Fleet availability provider failed and retries were exhausted',
  };
}

export function decideQuoteEscalation(
  status: QuoteStatusValue,
  reviewReasons: readonly string[],
): EscalationDecision | null {
  if (status !== QuoteStatus.PENDING_REVIEW) {
    return null;
  }
  return {
    tier: EscalationTier.T3,
    reason: EscalationReason.QUOTE_NEEDS_REVIEW,
    detail: reviewReasons.length > 0 ? reviewReasons.join('; ') : 'Quote flagged for human review',
  };
}

export function decideMissingInfoEscalation(
  status: MissingInfoStatusValue,
  attempts: number,
): EscalationDecision | null {
  if (status !== MissingInfoStatus.NEEDS_INFO || attempts < MISSING_INFO_STALL_THRESHOLD) {
    return null;
  }
  return {
    tier: EscalationTier.T2,
    reason: EscalationReason.MISSING_INFO_STALLED,
    detail: `Customer has not provided required booking information after ${attempts} attempts`,
  };
}
