import { JourneyState, type JourneyStateValue } from '@ai-concierge/domain';

/**
 * How a customer sees where their request stands: a handful of plain-language
 * steps instead of the 25 internal journey states. Internal state names,
 * escalation tiers and staff details never reach the customer.
 */
export type CustomerStepKey = 'details' | 'driver' | 'car' | 'quote' | 'team' | 'booking' | 'ended';

export interface CustomerStep {
  key: CustomerStepKey;
  label: string;
  description: string;
}

export const CUSTOMER_STEPS: Record<CustomerStepKey, CustomerStep> = {
  details: {
    key: 'details',
    label: 'Sharing your details',
    description: 'Tell us the car, the dates and where you would like to pick it up.',
  },
  driver: {
    key: 'driver',
    label: 'Driver details',
    description: 'We need a few details about the driver to check eligibility.',
  },
  car: {
    key: 'car',
    label: 'Choosing your car',
    description: 'We are checking availability and, if needed, suggesting alternatives.',
  },
  quote: {
    key: 'quote',
    label: 'Quote ready',
    description:
      'Your quote is ready. Reply "confirm" in the chat and our team will take it from here.',
  },
  team: {
    key: 'team',
    label: 'With our team',
    description: 'A member of our team is looking after your request and will reply in the chat.',
  },
  booking: {
    key: 'booking',
    label: 'Booking in progress',
    description: 'Our team is completing your booking with you.',
  },
  ended: {
    key: 'ended',
    label: 'Request ended',
    description: 'This request has ended. Start a new chat any time.',
  },
};

const STEP_BY_STATE: Record<JourneyStateValue, CustomerStepKey> = {
  [JourneyState.ENQUIRY_RECEIVED]: 'details',
  [JourneyState.EXTRACTING_REQUIREMENTS]: 'details',
  [JourneyState.VEHICLE_SELECTION]: 'details',
  [JourneyState.COLLECTING_MISSING_INFO]: 'details',
  [JourneyState.ELIGIBILITY_CHECK]: 'driver',
  [JourneyState.AVAILABILITY_CHECK]: 'car',
  [JourneyState.OFFERING_ALTERNATIVES]: 'car',
  [JourneyState.QUOTE_ISSUED]: 'quote',
  [JourneyState.ESCALATED]: 'team',
  [JourneyState.DOCUMENTS_REQUESTED]: 'booking',
  [JourneyState.DOCUMENTS_VERIFYING]: 'booking',
  [JourneyState.PAYMENT_INSTRUCTED]: 'booking',
  [JourneyState.CRM_UPDATED]: 'booking',
  [JourneyState.AWAITING_HUMAN_APPROVAL]: 'booking',
  [JourneyState.CONFIRMED]: 'booking',
  [JourneyState.DELIVERY_SCHEDULED]: 'booking',
  [JourneyState.ON_RENTAL]: 'booking',
  [JourneyState.RETURN_SCHEDULED]: 'booking',
  [JourneyState.RETURNED]: 'booking',
  [JourneyState.FINAL_INVOICE_ISSUED]: 'booking',
  [JourneyState.FOLLOW_UP_SENT]: 'booking',
  [JourneyState.CLOSED]: 'booking',
  [JourneyState.CANCELLED]: 'ended',
  [JourneyState.DECLINED]: 'ended',
  [JourneyState.EXPIRED]: 'ended',
};

export function customerStepFor(state: JourneyStateValue | null): CustomerStep {
  return state === null ? CUSTOMER_STEPS.details : CUSTOMER_STEPS[STEP_BY_STATE[state]];
}

/** The four milestones drawn on the customer's progress bar, in order. */
export const PROGRESS_STEPS: readonly CustomerStepKey[] = ['details', 'driver', 'car', 'quote'];

/** How far along the progress bar a request is: the index of its step, or -1 when it is not on the bar. */
export function progressIndex(state: JourneyStateValue | null): number {
  const key = state === null ? 'details' : STEP_BY_STATE[state];
  if (key === 'booking') return PROGRESS_STEPS.length;
  return PROGRESS_STEPS.indexOf(key);
}
