import { JourneyState, type JourneyStateValue } from '@ai-concierge/domain';

const DANGER_STATES: JourneyStateValue[] = [
  JourneyState.ESCALATED,
  JourneyState.CANCELLED,
  JourneyState.DECLINED,
  JourneyState.EXPIRED,
];
const SUCCESS_STATES: JourneyStateValue[] = [JourneyState.CONFIRMED, JourneyState.CLOSED];

export function journeyStateTone(state: JourneyStateValue): 'success' | 'warning' | 'danger' {
  if (DANGER_STATES.includes(state)) return 'danger';
  if (SUCCESS_STATES.includes(state)) return 'success';
  return 'warning';
}
