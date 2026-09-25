import { redirect } from 'next/navigation';
import { fetchJourneyDetail, SessionExpiredError } from '../../../../lib/adminApi';
import { GlassCard } from '../../../../components/ui/GlassCard';
import { StatusChip } from '../../../../components/ui/StatusChip';
import { formatEnumLabel, formatFieldName } from '../../../../lib/format';
import { journeyStateTone } from '../../../../lib/journeyDisplay';

export default async function JourneyDetailPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;

  let journey, transitions;
  try {
    const result = await fetchJourneyDetail(conversationId);
    journey = result.journey;
    transitions = result.transitions;
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  const contextEntries = Object.entries(journey.context).filter(([, value]) => value !== undefined);

  return (
    <div className="mx-auto max-w-2xl py-8">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={journeyStateTone(journey.state)}>
          {formatEnumLabel(journey.state)}
        </StatusChip>
        <span className="text-xs text-cream-50/50">version {journey.version}</span>
      </div>
      <p className="mt-2 font-mono text-xs text-cream-50/60">{journey.conversationId}</p>

      <GlassCard className="mt-6">
        <h2 className="text-xs uppercase tracking-wide text-cream-50/70">Context</h2>
        <dl className="mt-3 space-y-2">
          {contextEntries.length === 0 && (
            <p className="text-sm text-cream-50/50">No context recorded.</p>
          )}
          {contextEntries.map(([key, value]) => (
            <div key={key} className="flex justify-between gap-4 text-sm">
              <dt className="text-cream-50/60">{formatFieldName(key)}</dt>
              <dd className="text-right font-mono text-cream-50">{String(value ?? '—')}</dd>
            </div>
          ))}
        </dl>
      </GlassCard>

      <GlassCard className="mt-4">
        <h2 className="text-xs uppercase tracking-wide text-cream-50/70">Timeline</h2>
        <ol className="mt-3 space-y-4">
          {transitions.map((transition) => (
            <li key={transition.id} className="border-l border-copper-300/40 pl-4">
              <div className="flex flex-wrap items-center gap-2 text-sm text-cream-50">
                <span className="text-cream-50/50">
                  {transition.fromState ? formatEnumLabel(transition.fromState) : 'Start'} →
                </span>
                <span>{formatEnumLabel(transition.toState)}</span>
                <StatusChip tone="neutral">{transition.actor}</StatusChip>
              </div>
              <p className="mt-1 text-xs text-cream-50/60">{transition.reason}</p>
              <p className="mt-1 text-xs text-cream-50/40">
                {new Date(transition.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ol>
      </GlassCard>
    </div>
  );
}
