import Link from 'next/link';
import { redirect } from 'next/navigation';
import { fetchQuotes, SessionExpiredError } from '../../../lib/adminApi';
import { AutoRefresh } from '../../../components/dashboard/AutoRefresh';
import { GlassCard } from '../../../components/ui/GlassCard';
import { StatusChip } from '../../../components/ui/StatusChip';
import { formatDateTime, formatMoney } from '../../../lib/format';

export const metadata = { title: 'Quotes · AI Concierge' };

export default async function QuotesPage() {
  let items;
  try {
    items = (await fetchQuotes({ limit: 50, offset: 0 })).items;
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  return (
    <div className="mx-auto max-w-4xl py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">Quotes</h1>
          <p className="mt-2 text-sm text-cream-50/70">
            Every quote the concierge has issued, latest version of each, newest first. Prices come
            only from the pricing engine — never from the AI.
          </p>
        </div>
        <AutoRefresh />
      </div>

      <div className="mt-6 space-y-3">
        {items.length === 0 && (
          <GlassCard>
            <p className="text-sm text-cream-50/70">No quotes issued yet.</p>
          </GlassCard>
        )}
        {items.map((quote) => {
          const expired = new Date(quote.validUntil).getTime() < Date.now();
          return (
            <Link key={quote.quoteId} href={`/dashboard/journeys/${quote.conversationId}`}>
              <GlassCard className="transition-transform duration-150 hover:scale-[1.005]">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip tone={quote.status === 'ISSUED' ? 'success' : 'warning'}>
                    {quote.status === 'ISSUED' ? 'Issued' : 'Pending review'}
                  </StatusChip>
                  {expired && <StatusChip tone="danger">Expired</StatusChip>}
                  <StatusChip tone="neutral">{quote.channel}</StatusChip>
                  <span className="ml-auto text-xs text-cream-50/50">
                    {formatDateTime(quote.createdAt)}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-cream-50">{quote.vehicleName}</p>
                  <p className="font-display text-xl font-semibold tabular-nums text-cream-50">
                    {formatMoney(quote.total.minorUnits, quote.total.currency)}
                  </p>
                </div>
                <p className="mt-1 text-xs text-cream-50/60">
                  {quote.customerRef} · deposit{' '}
                  {formatMoney(quote.deposit.minorUnits, quote.deposit.currency)} · valid until{' '}
                  {formatDateTime(quote.validUntil)}
                </p>
              </GlassCard>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
