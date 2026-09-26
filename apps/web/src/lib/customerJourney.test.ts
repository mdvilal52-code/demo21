import { JourneyState } from '@ai-concierge/domain';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_STEPS, customerStepFor, progressIndex } from './customerJourney';

describe('customer-facing journey steps', () => {
  it('describes every one of the internal journey states in plain language', () => {
    for (const state of Object.values(JourneyState)) {
      const step = customerStepFor(state);
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.description.length).toBeGreaterThan(0);
      // No internal vocabulary leaks to the customer.
      expect(`${step.label} ${step.description}`).not.toMatch(
        /ESCALAT|ELIGIBILITY_CHECK|_|tier|T2|T3/,
      );
    }
  });

  it('starts a new visitor at the first step', () => {
    expect(customerStepFor(null)).toBe(CUSTOMER_STEPS.details);
    expect(progressIndex(null)).toBe(0);
  });

  it('moves the progress bar forward as the request advances', () => {
    expect(progressIndex(JourneyState.COLLECTING_MISSING_INFO)).toBe(0);
    expect(progressIndex(JourneyState.ELIGIBILITY_CHECK)).toBe(1);
    expect(progressIndex(JourneyState.OFFERING_ALTERNATIVES)).toBe(2);
    expect(progressIndex(JourneyState.QUOTE_ISSUED)).toBe(3);
    expect(progressIndex(JourneyState.CONFIRMED)).toBe(4);
  });

  it('keeps hand-over and ended requests off the progress bar', () => {
    expect(progressIndex(JourneyState.ESCALATED)).toBe(-1);
    expect(progressIndex(JourneyState.DECLINED)).toBe(-1);
  });
});
