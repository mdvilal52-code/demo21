import { JourneyState } from '@ai-concierge/domain';
import { describe, expect, it } from 'vitest';
import {
  ENDED_STATES,
  MILESTONES,
  NEEDS_PERSON_STATES,
  endedCount,
  milestoneCounts,
  needsPersonCount,
} from './journeyMilestones';

describe('journey milestones', () => {
  it('places every journey state in exactly one bucket, so no journey is ever uncounted or counted twice', () => {
    const all = Object.values(JourneyState);
    const placed = [
      ...MILESTONES.flatMap((milestone) => milestone.states),
      ...NEEDS_PERSON_STATES,
      ...ENDED_STATES,
    ];
    expect([...placed].sort()).toEqual([...all].sort());
  });

  it('sums live counts per milestone', () => {
    const byState = [
      { state: 'ELIGIBILITY_CHECK', count: 2 },
      { state: 'OFFERING_ALTERNATIVES', count: 1 },
      { state: 'QUOTE_ISSUED', count: 4 },
      { state: 'ESCALATED', count: 3 },
      { state: 'DECLINED', count: 5 },
      { state: 'CANCELLED', count: 1 },
    ];
    const counts = Object.fromEntries(milestoneCounts(byState).map((m) => [m.key, m.count]));
    expect(counts).toEqual({ enquiry: 0, details: 0, checks: 3, quote: 4, booking: 0 });
    expect(needsPersonCount(byState)).toBe(3);
    expect(endedCount(byState)).toBe(6);
  });
});
