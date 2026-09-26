import Link from 'next/link';
import type { MilestoneCount } from '../../lib/journeyMilestones';

/**
 * The customer journey as five milestones with the live number of journeys
 * sitting at each (docs/DESIGN-SYSTEM.md JourneyStepper). Copper dots are lit
 * where at least one journey currently is; people-owned and ended journeys are
 * not steps on the way, so they sit beside the stepper, not in it.
 */
export function JourneyStepper({
  milestones,
  needsPerson,
  ended,
}: {
  milestones: MilestoneCount[];
  needsPerson: number;
  ended: number;
}) {
  return (
    <div>
      <ol
        className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-0"
        aria-label="Customer journey"
      >
        {milestones.map((milestone, index) => (
          <li
            key={milestone.key}
            className="relative flex flex-1 items-center gap-3 sm:flex-col sm:gap-2"
          >
            {index > 0 && (
              <span
                aria-hidden="true"
                className="absolute right-1/2 top-[7px] hidden h-px w-full bg-copper-300/30 sm:block"
              />
            )}
            <span
              aria-hidden="true"
              className={`relative z-10 h-4 w-4 shrink-0 rounded-full border ${
                milestone.count > 0
                  ? 'border-copper-300 bg-copper-500 shadow-[0_0_10px_rgba(200,134,90,0.7)]'
                  : 'border-copper-300/50 bg-emerald-900'
              }`}
            />
            <div className="sm:text-center">
              <p className="text-xs uppercase tracking-[0.12em] text-cream-50/70">
                {milestone.label}
              </p>
              <p
                className="font-display text-2xl font-semibold tabular-nums text-cream-50"
                data-testid={`milestone-${milestone.key}`}
              >
                {milestone.count}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex flex-wrap gap-3 text-xs">
        <Link
          href="/dashboard/journeys?state=ESCALATED"
          className="rounded-pill border border-danger/40 bg-danger/10 px-3 py-1 uppercase tracking-wide text-danger"
        >
          With a person · {needsPerson}
        </Link>
        <span className="rounded-pill border border-white/15 bg-white/5 px-3 py-1 uppercase tracking-wide text-cream-50/70">
          Ended (cancelled, declined, expired) · {ended}
        </span>
      </div>
    </div>
  );
}
