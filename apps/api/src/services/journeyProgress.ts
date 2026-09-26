import type {
  EligibilityIntakeFieldValue,
  JourneyStateValue,
  QuoteSnapshot,
  RecommendAlternativesResult,
} from '@ai-concierge/domain';

/**
 * Where the automatic journey engine (`journeyAutopilotService.ts`) got to
 * for one inbound customer message, described in exactly the facts the reply
 * layer (`journeyReplyService.ts`) is allowed to talk about. Every field here
 * comes from an already-persisted, already-validated step result — the reply
 * layer never invents a price, date, availability or eligibility outcome, it
 * only words what is in this object.
 */
export type HumanReviewCause =
  | 'ELIGIBILITY_REVIEW'
  | 'AVAILABILITY_PROVIDER'
  | 'QUOTE_REVIEW'
  | 'QUOTE_EXPIRED'
  | 'CUSTOMER_REQUESTED'
  | 'COMPLAINT'
  | 'BOOKING_HANDOFF'
  | 'DETAILS_STALLED'
  | 'PROCESSING_ERROR';

export type JourneyProgress =
  /** Still collecting Step 1-4 information (or not a booking enquiry): the existing Step 4 reply applies. */
  | { stage: 'STEP4_PENDING' }
  /** Step 4 is complete; Step 5 needs driver details the customer has not fully given yet. */
  | {
      stage: 'NEEDS_ELIGIBILITY_INFO';
      missing: EligibilityIntakeFieldValue[];
      /** The customer wrote a date of birth that could be read two ways. */
      dateOfBirthAmbiguous: boolean;
      /** First time we are asking (vs. re-asking for what is still missing). */
      firstAsk: boolean;
    }
  | { stage: 'ELIGIBILITY_DECLINED'; reason: string }
  | {
      stage: 'ALTERNATIVES';
      alternatives: RecommendAlternativesResult;
      /** Why the requested car could not be offered. */
      requestedStatus: 'UNAVAILABLE' | 'MAINTENANCE' | 'STILL_LOOKING';
    }
  | { stage: 'QUOTE_ISSUED'; quote: QuoteSnapshot; holdExpiresAt: string | null }
  | { stage: 'QUOTE_FOLLOWUP'; quote: QuoteSnapshot; holdExpiresAt: string | null }
  | {
      stage: 'HUMAN_REVIEW';
      cause: HumanReviewCause;
      /** False when the hand-off could not be recorded — the reply must not claim a person was notified. */
      handoffRecorded: boolean;
    }
  /** A human already owns this journey; the concierge only acknowledges. */
  | { stage: 'ESCALATED_WAITING' }
  /** A later journey step (documents, payment, ...) that has no automation yet. */
  | { stage: 'LATER_STAGE'; state: JourneyStateValue }
  | { stage: 'CLOSED'; state: JourneyStateValue };

export type JourneyProgressStage = JourneyProgress['stage'];
