import { redirect } from 'next/navigation';
import Link from 'next/link';
import { fetchCustomers, SessionExpiredError } from '../../../lib/adminApi';
import { GlassCard } from '../../../components/ui/GlassCard';
import { StatusChip } from '../../../components/ui/StatusChip';

export default async function CustomersPage() {
  let items;
  try {
    const result = await fetchCustomers({ limit: 50, offset: 0 });
    items = result.items;
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  return (
    <div className="mx-auto max-w-3xl py-8">
      <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">Customers</h1>
      <p className="mt-2 text-sm text-cream-50/70">
        CRM records, kept in sync automatically as each journey progresses.
      </p>

      <div className="mt-6 space-y-3">
        {items.length === 0 && (
          <GlassCard>
            <p className="text-sm text-cream-50/70">No customers yet.</p>
          </GlassCard>
        )}

        {items.map((customer) => (
          <Link key={customer.id} href={`/dashboard/customers/${customer.id}`}>
            <GlassCard className="transition-transform duration-150 hover:scale-[1.005]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm text-cream-50">
                    {customer.displayName ?? customer.customerRef}
                  </p>
                  <p className="text-xs text-cream-50/50">
                    {customer.channel} · {customer.customerRef}
                  </p>
                </div>
                <StatusChip tone="neutral">{`${customer.bookingCount} bookings`}</StatusChip>
              </div>
              <p className="mt-2 text-xs text-cream-50/40">
                Last activity {new Date(customer.lastActivityAt).toLocaleString()}
              </p>
            </GlassCard>
          </Link>
        ))}
      </div>
    </div>
  );
}
