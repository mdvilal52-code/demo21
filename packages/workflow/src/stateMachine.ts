import {
  JourneyState,
  TERMINAL_JOURNEY_STATES,
  type JourneyStateValue,
} from '@ai-concierge/domain';

/**
 * The Event/Workflow Engine's guarded transition table — MASTER-PLAN.md §4's
 * "State" column, wired exactly as that section's "Side effects /
 * compensation" and overlay-state notes describe. Pure data + a pure guard
 * function, zero I/O — the same "orchestrator proposes/decides, the caller
 * does I/O" split every packages/ai/stepN orchestrator already uses.
 *
 * `ESCALATED` is modeled as resumable to any non-terminal state (MASTER-PLAN.md
 * §4: "Overlay states: ESCALATED(tier, reason) (resumable)") — a case
 * resolved as APPROVED returns the journey to wherever it was escalated
 * from, never to a fixed "next" state; `journeyService.ts` passes the
 * specific target when resuming, and `canTransition` only confirms it is a
 * legal one.
 */
const TRANSITIONS: Record<JourneyStateValue, readonly JourneyStateValue[]> = {
  [JourneyState.ENQUIRY_RECEIVED]: [JourneyState.EXTRACTING_REQUIREMENTS, JourneyState.CANCELLED],
  [JourneyState.EXTRACTING_REQUIREMENTS]: [JourneyState.VEHICLE_SELECTION, JourneyState.CANCELLED],
  [JourneyState.VEHICLE_SELECTION]: [JourneyState.COLLECTING_MISSING_INFO, JourneyState.CANCELLED],
  [JourneyState.COLLECTING_MISSING_INFO]: [
    // Self-loop: MASTER-PLAN.md §4 Step 4 — "loop until complete or
    // timeout". Every subsequent customer reply that still leaves a
    // required field missing re-asks rather than transitions; the loop
    // is a real, logged event (a new JourneyTransition row each time,
    // driving the stall-escalation attempt counter — see
    // decideMissingInfoEscalation), never silently dropped.
    JourneyState.COLLECTING_MISSING_INFO,
    JourneyState.ELIGIBILITY_CHECK,
    JourneyState.ESCALATED,
    JourneyState.EXPIRED,
    JourneyState.CANCELLED,
  ],
  [JourneyState.ELIGIBILITY_CHECK]: [
    JourneyState.AVAILABILITY_CHECK,
    JourneyState.ESCALATED,
    JourneyState.DECLINED,
    JourneyState.CANCELLED,
  ],
  [JourneyState.AVAILABILITY_CHECK]: [
    JourneyState.QUOTE_ISSUED,
    JourneyState.OFFERING_ALTERNATIVES,
    JourneyState.ESCALATED,
    JourneyState.CANCELLED,
  ],
  [JourneyState.OFFERING_ALTERNATIVES]: [JourneyState.AVAILABILITY_CHECK, JourneyState.CANCELLED],
  [JourneyState.QUOTE_ISSUED]: [
    JourneyState.DOCUMENTS_REQUESTED,
    JourneyState.ESCALATED,
    JourneyState.CANCELLED,
  ],
  [JourneyState.DOCUMENTS_REQUESTED]: [JourneyState.DOCUMENTS_VERIFYING, JourneyState.CANCELLED],
  [JourneyState.DOCUMENTS_VERIFYING]: [
    JourneyState.PAYMENT_INSTRUCTED,
    JourneyState.DOCUMENTS_REQUESTED,
    JourneyState.ESCALATED,
    JourneyState.CANCELLED,
  ],
  [JourneyState.PAYMENT_INSTRUCTED]: [
    JourneyState.CRM_UPDATED,
    JourneyState.EXPIRED,
    JourneyState.CANCELLED,
  ],
  [JourneyState.CRM_UPDATED]: [
    JourneyState.AWAITING_HUMAN_APPROVAL,
    JourneyState.CONFIRMED,
    JourneyState.CANCELLED,
  ],
  [JourneyState.AWAITING_HUMAN_APPROVAL]: [
    JourneyState.CONFIRMED,
    JourneyState.DECLINED,
    JourneyState.CANCELLED,
  ],
  [JourneyState.CONFIRMED]: [JourneyState.DELIVERY_SCHEDULED, JourneyState.CANCELLED],
  [JourneyState.DELIVERY_SCHEDULED]: [JourneyState.ON_RENTAL, JourneyState.CANCELLED],
  [JourneyState.ON_RENTAL]: [JourneyState.RETURN_SCHEDULED, JourneyState.ESCALATED],
  [JourneyState.RETURN_SCHEDULED]: [JourneyState.RETURNED, JourneyState.ESCALATED],
  [JourneyState.RETURNED]: [JourneyState.FINAL_INVOICE_ISSUED],
  [JourneyState.FINAL_INVOICE_ISSUED]: [JourneyState.FOLLOW_UP_SENT],
  [JourneyState.FOLLOW_UP_SENT]: [JourneyState.CLOSED],
  [JourneyState.CLOSED]: [],
  [JourneyState.ESCALATED]: Object.values(JourneyState).filter(
    (state) => state !== JourneyState.ESCALATED,
  ) as JourneyStateValue[],
  [JourneyState.CANCELLED]: [],
  [JourneyState.DECLINED]: [],
  [JourneyState.EXPIRED]: [],
};

export function isTerminalState(state: JourneyStateValue): boolean {
  return TERMINAL_JOURNEY_STATES.includes(state);
}

/**
 * `TRANSITIONS` is exhaustive over every `JourneyStateValue` by construction
 * (a missing key would be a compile error above), so the `?? []` here is a
 * defensive fallback only `noUncheckedIndexedAccess` requires syntactically
 * — never a real runtime path — same "fail safe rather than throw" posture
 * `checkTransition` itself takes for an already-terminal `from`.
 */
export function getAllowedNextStates(from: JourneyStateValue): readonly JourneyStateValue[] {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from: JourneyStateValue, to: JourneyStateValue): boolean {
  return getAllowedNextStates(from).includes(to);
}

export interface TransitionRequest {
  from: JourneyStateValue;
  to: JourneyStateValue;
  reason: string;
}

export type TransitionCheck = { allowed: true } | { allowed: false; error: string };

/** The one gate every persisted transition must pass through — see journeyRepository.transitionJourney. */
export function checkTransition(request: TransitionRequest): TransitionCheck {
  if (isTerminalState(request.from)) {
    return { allowed: false, error: `Journey is already in terminal state ${request.from}` };
  }
  if (!canTransition(request.from, request.to)) {
    return {
      allowed: false,
      error: `Illegal transition ${request.from} -> ${request.to}`,
    };
  }
  return { allowed: true };
}
