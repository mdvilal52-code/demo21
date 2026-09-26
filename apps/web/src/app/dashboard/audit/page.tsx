import Link from 'next/link';
import { Permission } from '@ai-concierge/domain';
import { redirect } from 'next/navigation';
import { fetchAuditEvents, SessionExpiredError } from '../../../lib/adminApi';
import { getCurrentUser } from '../../../lib/getCurrentUser';
import { hasPermission } from '../../../lib/dashboardNav';
import { formatDateTime } from '../../../lib/format';
import { NoAccess } from '../../../components/dashboard/NoAccess';
import { GlassCard } from '../../../components/ui/GlassCard';

export const metadata = { title: 'Audit log · AI Concierge' };

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!hasPermission(user.role, Permission.AUDIT_EVENT_READ))
    return <NoAccess section="Audit log" />;

  const { cursor } = await searchParams;
  let page;
  try {
    page = await fetchAuditEvents({ limit: 25, ...(cursor ? { cursor } : {}) });
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  return (
    <div className="mx-auto max-w-4xl py-8">
      <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">Audit log</h1>
      <p className="mt-2 text-sm text-cream-50/70">
        Every change the system or a staff member makes is recorded here, newest first. Message text
        is never stored in this log.
      </p>

      <div className="mt-6 space-y-3">
        {page.items.length === 0 && (
          <GlassCard>
            <p className="text-sm text-cream-50/70">No audit events yet.</p>
          </GlassCard>
        )}
        {page.items.map((event) => (
          <GlassCard key={event.id} className="!p-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="font-mono text-sm text-cream-50">{event.action}</p>
              <p className="text-xs text-cream-50/60">
                {event.entityType} <span className="font-mono">{event.entityId.slice(0, 8)}</span>
              </p>
              <p className="ml-auto text-xs text-cream-50/50">{formatDateTime(event.createdAt)}</p>
            </div>
            <p className="mt-1 text-xs text-cream-50/60">
              by <span className="font-mono text-cream-50/80">{event.actor}</span>
              {event.ip ? ` · ${event.ip}` : ''}
              {event.requestId ? ` · request ${event.requestId.slice(0, 8)}` : ''}
            </p>
            {(event.before || event.after) && (
              <details className="mt-2 text-xs text-cream-50/70">
                <summary className="cursor-pointer text-copper-300">Details</summary>
                <pre className="mt-2 overflow-x-auto rounded-xl bg-emerald-900/60 p-3 text-[11px] leading-relaxed">
                  {JSON.stringify({ before: event.before, after: event.after }, null, 2)}
                </pre>
              </details>
            )}
          </GlassCard>
        ))}
      </div>

      <div className="mt-6 flex gap-3 text-xs">
        {cursor && (
          <Link
            href="/dashboard/audit"
            className="rounded-pill border border-white/10 px-4 py-2 uppercase tracking-wide text-cream-50/70"
          >
            ← Newest
          </Link>
        )}
        {page.nextCursor && (
          <Link
            href={`/dashboard/audit?cursor=${page.nextCursor}`}
            className="rounded-pill border border-white/10 px-4 py-2 uppercase tracking-wide text-cream-50/70"
          >
            Older →
          </Link>
        )}
      </div>
    </div>
  );
}
