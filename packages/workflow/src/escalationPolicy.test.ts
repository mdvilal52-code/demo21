import { describe, expect, it } from 'vitest';
import {
  EligibilityDecisionStatus,
  EscalationReason,
  EscalationTier,
  InventoryStatus,
  MissingInfoStatus,
  QuoteStatus,
} from '@ai-concierge/domain';
import {
  decideAvailabilityEscalation,
  decideEligibilityEscalation,
  decideMissingInfoEscalation,
  decideQuoteEscalation,
} from './escalationPolicy.js';

describe('decideEligibilityEscalation', () => {
  it('escalates to T3 when eligibility needs human review', () => {
    const decision = decideEligibilityEscalation(
      EligibilityDecisionStatus.NEEDS_HUMAN_REVIEW,
      'nationality exception matched but high-risk',
    );
    expect(decision).toEqual({
      tier: EscalationTier.T3,
      reason: EscalationReason.ELIGIBILITY_NEEDS_REVIEW,
      detail: 'nationality exception matched but high-risk',
    });
  });

  it('does not escalate an ELIGIBLE decision', () => {
    expect(decideEligibilityEscalation(EligibilityDecisionStatus.ELIGIBLE, 'ok')).toBeNull();
  });

  it('does not escalate an INELIGIBLE decision — that is a normal DECLINED outcome, not a human hand-off', () => {
    expect(
      decideEligibilityEscalation(EligibilityDecisionStatus.INELIGIBLE, 'underage'),
    ).toBeNull();
  });
});

describe('decideAvailabilityEscalation', () => {
  it('escalates to T2 on a retryable provider failure', () => {
    const decision = decideAvailabilityEscalation(InventoryStatus.UNKNOWN, true, 'timeout');
    expect(decision).toEqual({
      tier: EscalationTier.T2,
      reason: EscalationReason.AVAILABILITY_PROVIDER_FAILURE,
      detail: 'timeout',
    });
  });

  it('does not escalate a genuine UNAVAILABLE result', () => {
    expect(decideAvailabilityEscalation(InventoryStatus.UNAVAILABLE, false, null)).toBeNull();
  });

  it('does not escalate UNKNOWN when it is not marked retryable', () => {
    expect(decideAvailabilityEscalation(InventoryStatus.UNKNOWN, false, null)).toBeNull();
  });
});

describe('decideQuoteEscalation', () => {
  it('escalates to T3 when a quote is PENDING_REVIEW, carrying the review reasons', () => {
    const decision = decideQuoteEscalation(QuoteStatus.PENDING_REVIEW, [
      'large discount',
      'zero total',
    ]);
    expect(decision).toEqual({
      tier: EscalationTier.T3,
      reason: EscalationReason.QUOTE_NEEDS_REVIEW,
      detail: 'large discount; zero total',
    });
  });

  it('does not escalate an ISSUED quote', () => {
    expect(decideQuoteEscalation(QuoteStatus.ISSUED, [])).toBeNull();
  });
});

describe('decideMissingInfoEscalation', () => {
  it('does not escalate before the stall threshold', () => {
    expect(decideMissingInfoEscalation(MissingInfoStatus.NEEDS_INFO, 1)).toBeNull();
    expect(decideMissingInfoEscalation(MissingInfoStatus.NEEDS_INFO, 2)).toBeNull();
  });

  it('escalates to T2 once the stall threshold is reached', () => {
    const decision = decideMissingInfoEscalation(MissingInfoStatus.NEEDS_INFO, 3);
    expect(decision?.tier).toBe(EscalationTier.T2);
    expect(decision?.reason).toBe(EscalationReason.MISSING_INFO_STALLED);
  });

  it('does not escalate a COMPLETE result regardless of attempt count', () => {
    expect(decideMissingInfoEscalation(MissingInfoStatus.COMPLETE, 10)).toBeNull();
  });
});
