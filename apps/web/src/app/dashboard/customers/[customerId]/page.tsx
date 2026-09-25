import { redirect } from 'next/navigation';
import { fetchCustomerDetail, SessionExpiredError } from '../../../../lib/adminApi';
import { GlassCard } from '../../../../components/ui/GlassCard';
import { StatusChip } from '../../../../components/ui/StatusChip';
import { formatEnumLabel } from '../../../../lib/format';

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;

  let customer, timeline;
  try {
    const result = await fetchCustomerDetail(customerId);
    customer = result.customer;
    timeline = result.timeline;
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  return (
    <div className="mx-auto max-w-2xl py-8">
      <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">
        {customer.displayName ?? customer.customerRef}
      </h1>
      <p className="mt-1 text-sm text-cream-50/60">
        {customer.channel} · {customer.customerRef}
      </p>

      <GlassCard className="mt-6">
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-cream-50/60">Bookings</dt>
            <dd className="mt-1 text-cream-50">{customer.bookingCount}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-cream-50/60">Last activity</dt>
            <dd className="mt-1 text-cream-50">
              {new Date(customer.lastActivityAt).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-cream-50/60">Customer since</dt>
            <dd className="mt-1 text-cream-50">
              {new Date(customer.createdAt).toLocaleDateString()}
            </dd>
          </div>
        </dl>
      </GlassCard>

      <GlassCard className="mt-4">
        <h2 className="text-xs uppercase tracking-wide text-cream-50/70">Timeline</h2>
        <ol className="mt-3 space-y-4">
          {timeline.length === 0 && (
            <p className="text-sm text-cream-50/50">No activity recorded.</p>
          )}
          {timeline.map((event) => (
            <li key={event.id} className="border-l border-copper-300/40 pl-4">
              <div className="flex items-center gap-2">
                <StatusChip tone="neutral">{formatEnumLabel(event.type)}</StatusChip>
              </div>
              <p className="mt-1 text-sm text-cream-50">{event.summary}</p>
              <p className="mt-1 text-xs text-cream-50/40">
                {new Date(event.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ol>
      </GlassCard>
    </div>
  );
}
