import { describe, expect, it } from 'vitest';
import { JourneyState } from '@ai-concierge/domain';
import {
  canTransition,
  checkTransition,
  getAllowedNextStates,
  isTerminalState,
} from './stateMachine.js';

describe('state machine — the happy path (Steps 1-8)', () => {
  it('allows the exact Enquiry -> Quote sequence', () => {
    const path: (typeof JourneyState)[keyof typeof JourneyState][] = [
      JourneyState.ENQUIRY_RECEIVED,
      JourneyState.EXTRACTING_REQUIREMENTS,
      JourneyState.VEHICLE_SELECTION,
      JourneyState.COLLECTING_MISSING_INFO,
      JourneyState.ELIGIBILITY_CHECK,
      JourneyState.AVAILABILITY_CHECK,
      JourneyState.QUOTE_ISSUED,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('allows availability -> offering alternatives -> back to availability (a re-check for a different vehicle)', () => {
    expect(canTransition(JourneyState.AVAILABILITY_CHECK, JourneyState.OFFERING_ALTERNATIVES)).toBe(
      true,
    );
    expect(canTransition(JourneyState.OFFERING_ALTERNATIVES, JourneyState.AVAILABILITY_CHECK)).toBe(
      true,
    );
  });
});

describe('state machine — the missing-info loop', () => {
  it('allows COLLECTING_MISSING_INFO to loop to itself (another incomplete reply)', () => {
    expect(
      canTransition(JourneyState.COLLECTING_MISSING_INFO, JourneyState.COLLECTING_MISSING_INFO),
    ).toBe(true);
  });

  it('no other state allows looping to itself', () => {
    for (const state of Object.values(JourneyState)) {
      if (state === JourneyState.COLLECTING_MISSING_INFO || state === JourneyState.ESCALATED) {
        continue; // COLLECTING_MISSING_INFO's loop is asserted above; ESCALATED's non-self-loop is asserted separately below.
      }
      expect(canTransition(state, state)).toBe(false);
    }
  });
});

describe('state machine — illegal transitions', () => {
  it('rejects skipping a step (Enquiry straight to Quote)', () => {
    expect(canTransition(JourneyState.ENQUIRY_RECEIVED, JourneyState.QUOTE_ISSUED)).toBe(false);
  });

  it('rejects going backwards (Quote back to Enquiry)', () => {
    expect(canTransition(JourneyState.QUOTE_ISSUED, JourneyState.ENQUIRY_RECEIVED)).toBe(false);
  });

  it('rejects any transition out of a terminal state', () => {
    for (const terminal of [
      JourneyState.CLOSED,
      JourneyState.CANCELLED,
      JourneyState.DECLINED,
      JourneyState.EXPIRED,
    ]) {
      expect(getAllowedNextStates(terminal)).toHaveLength(0);
      expect(checkTransition({ from: terminal, to: JourneyState.CONFIRMED, reason: 'x' })).toEqual({
        allowed: false,
        error: expect.stringContaining('terminal'),
      });
    }
  });
});

describe('state machine — escalation is resumable', () => {
  it('allows escalating from any non-terminal state', () => {
    expect(canTransition(JourneyState.ELIGIBILITY_CHECK, JourneyState.ESCALATED)).toBe(true);
    expect(canTransition(JourneyState.QUOTE_ISSUED, JourneyState.ESCALATED)).toBe(true);
  });

  it('allows resuming from ESCALATED back into the exact state it was escalated from', () => {
    expect(canTransition(JourneyState.ESCALATED, JourneyState.ELIGIBILITY_CHECK)).toBe(true);
    expect(canTransition(JourneyState.ESCALATED, JourneyState.AVAILABILITY_CHECK)).toBe(true);
  });

  it('never allows escalating from ESCALATED to itself', () => {
    expect(canTransition(JourneyState.ESCALATED, JourneyState.ESCALATED)).toBe(false);
  });
});

describe('checkTransition', () => {
  it('returns allowed:true for a legal transition', () => {
    expect(
      checkTransition({
        from: JourneyState.ENQUIRY_RECEIVED,
        to: JourneyState.EXTRACTING_REQUIREMENTS,
        reason: 'intent recognized',
      }),
    ).toEqual({ allowed: true });
  });

  it('returns a descriptive error for an illegal transition', () => {
    const result = checkTransition({
      from: JourneyState.ENQUIRY_RECEIVED,
      to: JourneyState.CLOSED,
      reason: 'x',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error).toContain('ENQUIRY_RECEIVED');
      expect(result.error).toContain('CLOSED');
    }
  });
});

describe('isTerminalState', () => {
  it('identifies exactly the four terminal states', () => {
    expect(isTerminalState(JourneyState.CLOSED)).toBe(true);
    expect(isTerminalState(JourneyState.CANCELLED)).toBe(true);
    expect(isTerminalState(JourneyState.DECLINED)).toBe(true);
    expect(isTerminalState(JourneyState.EXPIRED)).toBe(true);
    expect(isTerminalState(JourneyState.QUOTE_ISSUED)).toBe(false);
    expect(isTerminalState(JourneyState.ESCALATED)).toBe(false);
  });
});
