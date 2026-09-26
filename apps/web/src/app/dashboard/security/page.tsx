import Link from 'next/link';
import { Permission } from '@ai-concierge/domain';
import { redirect } from 'next/navigation';
import { fetchSecurityEvents, SessionExpiredError } from '../../../lib/adminApi';
import { getCurrentUser } from '../../../lib/getCurrentUser';
import { hasPermission } from '../../../lib/dashboardNav';
import { formatDateTime, formatEnumLabel } from '../../../lib/format';
import { NoAccess } from '../../../components/dashboard/NoAccess';
import { GlassCard } from '../../../components/ui/GlassCard';
import { StatusChip } from '../../../components/ui/StatusChip';

export const metadata = { title: 'Security · AI Concierge' };

const SEVERITIES = [
  { label: 'All', value: undefined },
  { label: 'Critical', value: 'CRITICAL' },
  { label: 'Warning', value: 'WARNING' },
  { label: 'Info', value: 'INFO' },
] as const;

function severityTone(severity: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (severity === 'CRITICAL') return 'danger';
  if (severity === 'WARNING') return 'warning';
  return 'neutral';
}

export default async function SecurityEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ severity?: string; cursor?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!hasPermission(user.role, Permission.SECURITY_EVENT_READ))
    return <NoAccess section="Security" />;

  const { severity, cursor } = await searchParams;
  let page;
  try {
    page = await fetchSecurityEvents({
      limit: 25,
      ...(severity ? { severity } : {}),
      ...(cursor ? { cursor } : {}),
    });
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  const baseQuery = severity ? `severity=${severity}&` : '';

  return (
    <div className="mx-auto max-w-4xl py-8">
      <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">
        Security events
      </h1>
      <p className="mt-2 text-sm text-cream-50/70">
        Sign-ins, lockouts, denied requests and anything unusual, newest first.
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        {SEVERITIES.map((filter) => (
          <Link
            key={filter.label}
            href={
              filter.value ? `/dashboard/security?severity=${filter.value}` : '/dashboard/security'
            }
            className={`rounded-pill px-4 py-2 text-xs font-medium uppercase tracking-wide transition-colors duration-150 ${
              (severity ?? undefined) === filter.value
                ? 'bg-copper-gradient text-ink-900'
                : 'border border-white/10 text-cream-50/70 hover:bg-emerald-700/40'
            }`}
          >
            {filter.label}
          </Link>
        ))}
      </div>

      <div className="mt-6 space-y-3">
        {page.items.length === 0 && (
          <GlassCard>
            <p className="text-sm text-cream-50/70">No security events here.</p>
          </GlassCard>
        )}
        {page.items.map((event) => (
          <GlassCard key={event.id} className="!p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone={severityTone(event.severity)}>
                {formatEnumLabel(event.severity)}
              </StatusChip>
              <p className="text-sm text-cream-50">{formatEnumLabel(event.type)}</p>
              <p className="ml-auto text-xs text-cream-50/50">{formatDateTime(event.createdAt)}</p>
            </div>
            <p className="mt-1 text-xs text-cream-50/60">
              {event.userId ? `user ${event.userId.slice(0, 8)}` : 'no user'}
              {event.ip ? ` · ${event.ip}` : ''}
            </p>
            {Object.keys(event.metadata).length > 0 && (
              <details className="mt-2 text-xs text-cream-50/70">
                <summary className="cursor-pointer text-copper-300">Details</summary>
                <pre className="mt-2 overflow-x-auto rounded-xl bg-emerald-900/60 p-3 text-[11px] leading-relaxed">
                  {JSON.stringify(event.metadata, null, 2)}
                </pre>
              </details>
            )}
          </GlassCard>
        ))}
      </div>

      <div className="mt-6 flex gap-3 text-xs">
        {cursor && (
          <Link
            href={`/dashboard/security${severity ? `?severity=${severity}` : ''}`}
            className="rounded-pill border border-white/10 px-4 py-2 uppercase tracking-wide text-cream-50/70"
          >
            ← Newest
          </Link>
        )}
        {page.nextCursor && (
          <Link
            href={`/dashboard/security?${baseQuery}cursor=${page.nextCursor}`}
            className="rounded-pill border border-white/10 px-4 py-2 uppercase tracking-wide text-cream-50/70"
          >
            Older →
          </Link>
        )}
      </div>
    </div>
  );
}
