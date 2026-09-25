import { redirect } from 'next/navigation';
import Link from 'next/link';
import { fetchJourneys, SessionExpiredError } from '../../../lib/adminApi';
import { GlassCard } from '../../../components/ui/GlassCard';
import { StatusChip } from '../../../components/ui/StatusChip';
import { formatEnumLabel } from '../../../lib/format';
import { journeyStateTone } from '../../../lib/journeyDisplay';

export default async function JourneysPage() {
  let items;
  try {
    const result = await fetchJourneys({ limit: 50, offset: 0 });
    items = result.items;
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  return (
    <div className="mx-auto max-w-3xl py-8">
      <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">Journeys</h1>
      <p className="mt-2 text-sm text-cream-50/70">
        Every customer conversation and where it stands in the 19-step flow, most recently updated
        first.
      </p>

      <div className="mt-6 space-y-3">
        {items.length === 0 && (
          <GlassCard>
            <p className="text-sm text-cream-50/70">No journeys yet.</p>
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
                  Updated {new Date(journey.updatedAt).toLocaleString()}
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
