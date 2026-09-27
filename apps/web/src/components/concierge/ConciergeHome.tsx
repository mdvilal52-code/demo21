'use client';

import Link from 'next/link';
import { customerStepFor } from '../../lib/customerJourney';
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';
import { CopperCard } from '../ui/CopperCard';
import { GlassCard } from '../ui/GlassCard';
import { Monogram } from '../ui/Monogram';
import { StatusChip } from '../ui/StatusChip';
import { useChatSession } from './useChatSession';

/**
 * Customer Home (docs/DESIGN-SYSTEM.md): the rental in progress, its quote,
 * documents and payment, and one big way to talk to the concierge. Documents
 * and payments are not automated yet, so those cards say exactly that rather
 * than showing anything that looks real.
 */
export function ConciergeHome() {
  const chat = useChatSession();
  const session = chat.session;
  const booking = session?.booking ?? null;
  const quote = session?.quote ?? null;
  const step = customerStepFor(session?.journeyState ?? null);
  const hasRequest = Boolean(booking?.vehicle) || quote !== null;

  return (
    <div className="mx-auto max-w-xl px-4 pb-8 pt-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <Monogram />
        <h1 className="font-display text-lg uppercase tracking-[0.22em] text-cream-50">
          AI Concierge
        </h1>
        <p className="text-sm text-cream-50/70">Luxury car rental in Dubai, arranged by chat.</p>
      </div>

      <div className="mt-8 space-y-4">
        <CopperCard data-testid="rental-card">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-900/70">
            Your rental
          </p>
          {hasRequest ? (
            <>
              <p className="mt-2 font-display text-xl font-semibold">
                {booking?.vehicle ?? 'Vehicle to be confirmed'}
              </p>
              <p className="mt-1 text-sm text-ink-900/80">
                {booking?.pickupDate && booking?.returnDate
                  ? `${formatDate(booking.pickupDate)} → ${formatDate(booking.returnDate)}`
                  : 'Dates to be confirmed'}
                {booking?.pickupLocation ? ` · ${booking.pickupLocation}` : ''}
              </p>
              <p className="mt-3 inline-block rounded-pill bg-ink-900/85 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-copper-100">
                {step.label}
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-ink-900/80">
              You have no request yet. Tell the concierge what you would like to rent and it will
              appear here.
            </p>
          )}
        </CopperCard>

        {quote && (
          <GlassCard>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.14em] text-cream-50/70">Quote</p>
              <StatusChip tone={quote.status === 'ISSUED' ? 'success' : 'warning'}>
                {quote.status === 'ISSUED' ? 'Ready' : 'Being reviewed'}
              </StatusChip>
            </div>
            <p className="mt-2 font-display text-2xl font-semibold tabular-nums text-cream-50">
              {formatMoney(quote.total.minorUnits, quote.total.currency)}
            </p>
            <p className="mt-1 text-xs text-cream-50/60">
              Valid until {formatDateTime(quote.validUntil)}
            </p>
            <Link
              href="/concierge/requests"
              className="mt-3 inline-block text-sm text-copper-300 underline"
            >
              See the full quote →
            </Link>
          </GlassCard>
        )}

        <GlassCard data-testid="documents-card">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.14em] text-cream-50/70">Documents</p>
            <StatusChip tone="neutral">Not available yet</StatusChip>
          </div>
          <p className="mt-2 text-sm text-cream-50/70">
            Document upload is not open yet. Our team will tell you exactly what is needed — a
            passport and driving licence — when they confirm your booking.
          </p>
        </GlassCard>

        <CopperCard data-testid="payment-card">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-900/70">Payment</p>
          <p className="mt-2 text-sm text-ink-900/85">
            {quote
              ? `Security deposit ${formatMoney(quote.deposit.minorUnits, quote.deposit.currency)} · total ${formatMoney(quote.total.minorUnits, quote.total.currency)}.`
              : 'Nothing to pay yet.'}{' '}
            Payment is arranged by our team once your booking is confirmed — you will never be asked
            to pay inside this chat.
          </p>
        </CopperCard>
      </div>

      <Link
        href="/concierge/chat"
        className="mt-8 flex w-full items-center justify-center rounded-pill bg-copper-gradient px-6 py-4 text-sm font-semibold uppercase tracking-[0.2em] text-ink-900 shadow-[0_14px_34px_rgba(0,0,0,0.38)] transition-[filter] duration-150 hover:brightness-105"
      >
        Contact AI
      </Link>
    </div>
  );
}
