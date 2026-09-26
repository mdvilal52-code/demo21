import { JourneyState, type JourneyStateValue } from '@ai-concierge/domain';

/**
 * The 25 journey states grouped into the five milestones of the Home screen's
 * JourneyStepper (docs/DESIGN-SYSTEM.md: Enquiry -> Dates -> Vehicle -> Quote
 * -> Booking, collapsed to five). `ESCALATED` (a person owns it) and the ended
 * states are shown separately because they are not steps on the way.
 */
export interface Milestone {
  key: string;
  label: string;
  states: readonly JourneyStateValue[];
}

export const MILESTONES: readonly Milestone[] = [
  {
    key: 'enquiry',
    label: 'Enquiry',
    states: [JourneyState.ENQUIRY_RECEIVED, JourneyState.EXTRACTING_REQUIREMENTS],
  },
  {
    key: 'details',
    label: 'Details',
    states: [JourneyState.VEHICLE_SELECTION, JourneyState.COLLECTING_MISSING_INFO],
  },
  {
    key: 'checks',
    label: 'Checks',
    states: [
      JourneyState.ELIGIBILITY_CHECK,
      JourneyState.AVAILABILITY_CHECK,
      JourneyState.OFFERING_ALTERNATIVES,
    ],
  },
  { key: 'quote', label: 'Quote', states: [JourneyState.QUOTE_ISSUED] },
  {
    key: 'booking',
    label: 'Booking',
    states: [
      JourneyState.DOCUMENTS_REQUESTED,
      JourneyState.DOCUMENTS_VERIFYING,
      JourneyState.PAYMENT_INSTRUCTED,
      JourneyState.CRM_UPDATED,
      JourneyState.AWAITING_HUMAN_APPROVAL,
      JourneyState.CONFIRMED,
      JourneyState.DELIVERY_SCHEDULED,
      JourneyState.ON_RENTAL,
      JourneyState.RETURN_SCHEDULED,
      JourneyState.RETURNED,
      JourneyState.FINAL_INVOICE_ISSUED,
      JourneyState.FOLLOW_UP_SENT,
      JourneyState.CLOSED,
    ],
  },
];

export const NEEDS_PERSON_STATES: readonly JourneyStateValue[] = [JourneyState.ESCALATED];
export const ENDED_STATES: readonly JourneyStateValue[] = [
  JourneyState.CANCELLED,
  JourneyState.DECLINED,
  JourneyState.EXPIRED,
];

function sumStates(
  byState: ReadonlyArray<{ state: string; count: number }>,
  states: readonly JourneyStateValue[],
): number {
  return byState
    .filter((row) => (states as readonly string[]).includes(row.state))
    .reduce((total, row) => total + row.count, 0);
}

export interface MilestoneCount {
  key: string;
  label: string;
  count: number;
}

export function milestoneCounts(
  byState: ReadonlyArray<{ state: string; count: number }>,
): MilestoneCount[] {
  return MILESTONES.map((milestone) => ({
    key: milestone.key,
    label: milestone.label,
    count: sumStates(byState, milestone.states),
  }));
}

export function needsPersonCount(byState: ReadonlyArray<{ state: string; count: number }>): number {
  return sumStates(byState, NEEDS_PERSON_STATES);
}

export function endedCount(byState: ReadonlyArray<{ state: string; count: number }>): number {
  return sumStates(byState, ENDED_STATES);
}
