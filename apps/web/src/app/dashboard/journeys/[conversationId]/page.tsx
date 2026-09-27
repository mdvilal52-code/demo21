import Link from 'next/link';
import { redirect } from 'next/navigation';
import { TERMINAL_JOURNEY_STATES } from '@ai-concierge/domain';
import { fetchJourneyDetail, fetchTranscript, SessionExpiredError } from '../../../../lib/adminApi';
import { AutoRefresh } from '../../../../components/dashboard/AutoRefresh';
import { ConversationThread } from '../../../../components/dashboard/ConversationThread';
import { ScrollingThread } from '../../../../components/dashboard/ScrollingThread';
import { QuotePanel } from '../../../../components/dashboard/QuotePanel';
import { StaffReplyForm } from '../../../../components/dashboard/StaffReplyForm';
import { GlassCard } from '../../../../components/ui/GlassCard';
import { StatusChip } from '../../../../components/ui/StatusChip';
import { formatDateTime, formatEnumLabel, formatFieldName } from '../../../../lib/format';
import { journeyStateTone } from '../../../../lib/journeyDisplay';

export const metadata = { title: 'Journey · AI Concierge' };

function eligibilityTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'ELIGIBLE') return 'success';
  if (status === 'INELIGIBLE') return 'danger';
  if (status === 'NEEDS_HUMAN_REVIEW') return 'warning';
  return 'neutral';
}

function yesNo(value: boolean | null): string {
  return value === null ? 'Not given' : value ? 'Yes' : 'No';
}

export default async function JourneyDetailPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;

  let detail, transcript;
  try {
    [detail, transcript] = await Promise.all([
      fetchJourneyDetail(conversationId),
      fetchTranscript(conversationId),
    ]);
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }
  const { journey, transitions } = detail;
  const ended = TERMINAL_JOURNEY_STATES.includes(journey.state);
  const contextEntries = Object.entries(journey.context).filter(([, value]) => value !== undefined);

  return (
    <div className="mx-auto max-w-6xl py-8">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={journeyStateTone(journey.state)}>
          {formatEnumLabel(journey.state)}
        </StatusChip>
        <StatusChip tone="neutral">{transcript.conversation.channel}</StatusChip>
        <span className="text-xs text-cream-50/50">version {journey.version}</span>
        {journey.state === 'ESCALATED' && (
          <Link href="/dashboard/escalations" className="text-xs text-copper-300 underline">
            Open the escalation queue
          </Link>
        )}
        <span className="ml-auto">
          <AutoRefresh intervalMs={8_000} />
        </span>
      </div>
      <h1 className="mt-3 font-display text-lg tracking-wide text-cream-50">
        {transcript.conversation.customerRef}
      </h1>
      <p className="mt-1 font-mono text-xs text-cream-50/50">{journey.conversationId}</p>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <GlassCard>
            <h2 className="text-xs uppercase tracking-wide text-cream-50/70">Conversation</h2>
            <div className="mt-4">
              <ScrollingThread>
                <ConversationThread messages={transcript.messages} />
              </ScrollingThread>
            </div>
            {ended ? (
              <p className="mt-4 rounded-2xl border border-white/10 bg-emerald-900/40 p-3 text-sm text-cream-50/70">
                This journey has ended ({formatEnumLabel(journey.state)}), so it can no longer be
                answered. A new message from the customer starts a new one.
              </p>
            ) : (
              <StaffReplyForm conversationId={journey.conversationId} />
            )}
          </GlassCard>
        </div>

        <div className="space-y-4">
          {transcript.quote && (
            <GlassCard>
              <h2 className="mb-3 text-xs uppercase tracking-wide text-cream-50/70">Quote</h2>
              <QuotePanel quote={transcript.quote} />
            </GlassCard>
          )}

          <GlassCard>
            <h2 className="text-xs uppercase tracking-wide text-cream-50/70">Eligibility</h2>
            {transcript.eligibility ? (
              <div className="mt-3 space-y-2">
                <StatusChip tone={eligibilityTone(transcript.eligibility.status)}>
                  {formatEnumLabel(transcript.eligibility.status)}
                </StatusChip>
                <p className="text-sm text-cream-50/80">{transcript.eligibility.reason}</p>
                <p className="text-xs text-cream-50/40">
                  {formatDateTime(transcript.eligibility.decidedAt)}
                </p>
              </div>
            ) : (
              <p className="mt-3 text-sm text-cream-50/60">Not checked yet.</p>
            )}
            {transcript.driverDetails && (
              <dl className="mt-4 space-y-2 border-t border-white/10 pt-3 text-sm">
                <p className="text-xs uppercase tracking-wide text-cream-50/50">
                  Driver details (as the customer stated them)
                </p>
                {(
                  [
                    ['Nationality', transcript.driverDetails.nationality ?? 'Not given'],
                    ['Licence type', transcript.driverDetails.licenseType ?? 'Not given'],
                    ['Licence valid', yesNo(transcript.driverDetails.hasValidLicense)],
                    ['Passport', yesNo(transcript.driverDetails.passportProvided)],
                    [
                      'Date of birth',
                      transcript.driverDetails.dateOfBirthProvided
                        ? 'Provided (hidden)'
                        : 'Not given',
                    ],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-4">
                    <dt className="text-cream-50/60">{label}</dt>
                    <dd className="text-right text-cream-50">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </GlassCard>

          <GlassCard>
            <h2 className="text-xs uppercase tracking-wide text-cream-50/70">Journey context</h2>
            <dl className="mt-3 space-y-2">
              {contextEntries.length === 0 && (
                <p className="text-sm text-cream-50/50">No context recorded.</p>
              )}
              {contextEntries.map(([key, value]) => (
                <div key={key} className="flex justify-between gap-4 text-sm">
                  <dt className="text-cream-50/60">{formatFieldName(key)}</dt>
                  <dd className="break-all text-right font-mono text-xs text-cream-50">
                    {String(value ?? '—')}
                  </dd>
                </div>
              ))}
            </dl>
          </GlassCard>

          <GlassCard>
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
                    {formatDateTime(transition.createdAt)}
                  </p>
                </li>
              ))}
            </ol>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
