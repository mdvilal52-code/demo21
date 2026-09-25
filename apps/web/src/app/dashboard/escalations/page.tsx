import { redirect } from 'next/navigation';
import Link from 'next/link';
import { EscalationStatus, type EscalationStatusValue } from '@ai-concierge/domain';
import { fetchEscalations, SessionExpiredError } from '../../../lib/adminApi';
import { getCurrentUser } from '../../../lib/getCurrentUser';
import { GlassCard } from '../../../components/ui/GlassCard';
import { StatusChip } from '../../../components/ui/StatusChip';
import { formatEnumLabel } from '../../../lib/format';
import { EscalationActions } from './EscalationActions';

const STATUS_FILTERS: { label: string; value: EscalationStatusValue | undefined }[] = [
  { label: 'All', value: undefined },
  { label: 'Open', value: EscalationStatus.OPEN },
  { label: 'In progress', value: EscalationStatus.IN_PROGRESS },
  { label: 'Resolved', value: EscalationStatus.RESOLVED },
  { label: 'Cancelled', value: EscalationStatus.CANCELLED },
];

function statusTone(status: EscalationStatusValue): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === EscalationStatus.OPEN) return 'danger';
  if (status === EscalationStatus.IN_PROGRESS) return 'warning';
  if (status === EscalationStatus.RESOLVED) return 'success';
  return 'neutral';
}

export default async function EscalationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  let items;
  try {
    const result = await fetchEscalations({
      ...(status ? { status } : {}),
      limit: 50,
      offset: 0,
    });
    items = result.items;
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  return (
    <div className="mx-auto max-w-3xl py-8">
      <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">
        Escalation queue
      </h1>
      <p className="mt-2 text-sm text-cream-50/70">
        Cases the AI could not resolve on its own — the human half of the automation.
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((filter) => {
          const href = filter.value
            ? `/dashboard/escalations?status=${filter.value}`
            : '/dashboard/escalations';
          const isActive = (status ?? undefined) === filter.value;
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

      <div className="mt-6 space-y-4">
        {items.length === 0 && (
          <GlassCard>
            <p className="text-sm text-cream-50/70">No escalations here.</p>
          </GlassCard>
        )}

        {items.map((escalationCase) => {
          const slaOverdue = escalationCase.slaBreached;
          return (
            <GlassCard key={escalationCase.id}>
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip tone="neutral">{escalationCase.tier}</StatusChip>
                <StatusChip tone={statusTone(escalationCase.status)}>
                  {formatEnumLabel(escalationCase.status)}
                </StatusChip>
                {slaOverdue && <StatusChip tone="danger">SLA breached</StatusChip>}
                <span className="ml-auto text-xs text-cream-50/50">
                  {new Date(escalationCase.createdAt).toLocaleString()}
                </span>
              </div>

              <h2 className="mt-3 text-sm font-medium text-cream-50">
                {formatEnumLabel(escalationCase.reason)}
              </h2>
              <p className="mt-1 text-sm text-cream-50/70">{escalationCase.detail}</p>

              {escalationCase.status === EscalationStatus.RESOLVED && (
                <div className="mt-3 rounded-2xl border border-white/10 bg-emerald-900/40 p-3 text-sm">
                  <p className="text-cream-50">
                    {escalationCase.resolution ? formatEnumLabel(escalationCase.resolution) : ''}
                  </p>
                  {escalationCase.resolutionNote && (
                    <p className="mt-1 text-cream-50/70">{escalationCase.resolutionNote}</p>
                  )}
                </div>
              )}

              <EscalationActions
                escalationCaseId={escalationCase.id}
                status={escalationCase.status}
                assignedToUserId={escalationCase.assignedToUserId}
                currentUserId={user.id}
              />
            </GlassCard>
          );
        })}
      </div>
    </div>
  );
}
