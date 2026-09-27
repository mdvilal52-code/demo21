import type { JourneyStateValue } from '@ai-concierge/domain';
import { CUSTOMER_STEPS, PROGRESS_STEPS, progressIndex } from '../../lib/customerJourney';

/** Four dots — details, driver, car, quote — lit up to wherever the customer's request has got to. */
export function ProgressBar({ state }: { state: JourneyStateValue | null }) {
  const reached = progressIndex(state);
  return (
    <ol className="mt-3 flex items-center gap-1.5" aria-label="Progress of your request">
      {PROGRESS_STEPS.map((key, index) => {
        const done = reached >= 0 && index <= reached;
        return (
          <li key={key} className="flex flex-1 flex-col gap-1">
            <span
              className={`h-1.5 rounded-full ${done ? 'bg-copper-500' : 'bg-white/15'}`}
              aria-hidden="true"
            />
            <span
              className={`text-[10px] uppercase tracking-wide ${done ? 'text-copper-100' : 'text-cream-50/40'}`}
            >
              {CUSTOMER_STEPS[key].label.split(' ')[0]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
