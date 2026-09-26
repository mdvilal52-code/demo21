import { redirect } from 'next/navigation';
import Link from 'next/link';
import { fetchJourneys, SessionExpiredError } from '../../../lib/adminApi';
import { AutoRefresh } from '../../../components/dashboard/AutoRefresh';
import { GlassCard } from '../../../components/ui/GlassCard';
import { StatusChip } from '../../../components/ui/StatusChip';
import { formatDateTime, formatEnumLabel } from '../../../lib/format';
import { journeyStateTone } from '../../../lib/journeyDisplay';

export const metadata = { title: 'Journeys · AI Concierge' };

const FILTERS: { label: string; state: string | undefined }[] = [
  { label: 'All', state: undefined },
  { label: 'With a person', state: 'ESCALATED' },
  { label: 'Driver details', state: 'ELIGIBILITY_CHECK' },
  { label: 'Alternatives', state: 'OFFERING_ALTERNATIVES' },
  { label: 'Quote issued', state: 'QUOTE_ISSUED' },
  { label: 'Declined', state: 'DECLINED' },
  { label: 'Cancelled', state: 'CANCELLED' },
];

export default async function JourneysPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;

  let items;
  try {
    const result = await fetchJourneys({ ...(state ? { state } : {}), limit: 50, offset: 0 });
    items = result.items;
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  return (
    <div className="mx-auto max-w-3xl py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">
            Journeys
          </h1>
          <p className="mt-2 text-sm text-cream-50/70">
            Every customer conversation and where it stands in the 19-step flow, most recently
            updated first.
          </p>
        </div>
        <AutoRefresh />
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((filter) => {
          const href = filter.state
            ? `/dashboard/journeys?state=${filter.state}`
            : '/dashboard/journeys';
          const isActive = (state ?? undefined) === filter.state;
          return (
            <Link
              key={filter.label}
              href={href}
              className={`rounded-pill px-4 py-2 text-xs font-medium uppercase tracking-wide transition-colors duration-150 ${
                isActive
                  ? 'bg-copper-gradient text-ink-900'
                  : 'border border-white/10 text-cream-50/70 hover:bg-emerald-700/40'
              }`}
            >
              {filter.label}
            </Link>
          );
        })}
      </div>

      <div className="mt-6 space-y-3">
        {items.length === 0 && (
          <GlassCard>
            <p className="text-sm text-cream-50/70">
              {state ? 'No journeys in this state.' : 'No journeys yet.'}
            </p>
          </GlassCard>
        )}

        {items.map((journey) => (
          <Link key={journey.id} href={`/dashboard/journeys/${journey.conversationId}`}>
            <GlassCard className="transition-transform duration-150 hover:scale-[1.005]">
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip tone={journeyStateTone(journey.state)}>
                  {formatEnumLabel(journey.state)}
                </StatusChip>
                <span className="ml-auto text-xs text-cream-50/50">
                  Updated {formatDateTime(journey.updatedAt)}
                </span>
              </div>
              <p className="mt-2 font-mono text-xs text-cream-50/60">{journey.conversationId}</p>
            </GlassCard>
          </Link>
        ))}
      </div>
    </div>
  );
}
