'use client';

import Link from 'next/link';
import {
  CUSTOMER_STEPS,
  PROGRESS_STEPS,
  customerStepFor,
  progressIndex,
} from '../../lib/customerJourney';
import { formatDate } from '../../lib/format';
import { CopperCard } from '../ui/CopperCard';
import { GlassCard } from '../ui/GlassCard';
import { QuoteCard } from './QuoteCard';
import { useChatSession } from './useChatSession';

/** "Bookings" for this stage of the product: the one request in progress, step by step, and its quote. */
export function RequestsView() {
  const chat = useChatSession();
  const session = chat.session;
  const state = session?.journeyState ?? null;
  const step = customerStepFor(state);
  const reached = progressIndex(state);
  const booking = session?.booking ?? null;

  return (
    <div className="mx-auto max-w-xl px-4 pb-8 pt-8">
      <h1 className="font-display text-base uppercase tracking-[0.18em] text-cream-50">
        Your requests
      </h1>

      {!session?.conversationId ? (
        <GlassCard className="mt-5">
          <p className="text-sm text-cream-50/80">
            You have not made a request yet. Start a chat and tell the concierge what you would like
            to rent.
          </p>
          <Link
            href="/concierge/chat"
            className="mt-3 inline-block text-sm text-copper-300 underline"
          >
            Start a chat →
          </Link>
        </GlassCard>
      ) : (
        <div className="mt-5 space-y-4">
          <CopperCard>
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-900/70">
              Current request
            </p>
            <p className="mt-2 font-display text-xl font-semibold">
              {booking?.vehicle ?? 'Vehicle to be confirmed'}
            </p>
            <p className="mt-1 text-sm text-ink-900/80">
              {booking?.pickupDate && booking?.returnDate
                ? `${formatDate(booking.pickupDate)} → ${formatDate(booking.returnDate)}`
                : 'Dates to be confirmed'}
              {booking?.pickupLocation ? ` · ${booking.pickupLocation}` : ''}
            </p>
          </CopperCard>

          <GlassCard>
            <p className="text-xs uppercase tracking-[0.14em] text-cream-50/70">Where it stands</p>
            <p className="mt-2 font-medium text-cream-50" data-testid="request-step">
              {step.label}
            </p>
            <p className="mt-1 text-sm text-cream-50/70">{step.description}</p>
            <ol className="mt-4 space-y-3">
              {PROGRESS_STEPS.map((key, index) => {
                const done = reached >= 0 && index <= reached;
                return (
                  <li key={key} className="flex items-start gap-3">
                    <span
                      className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${
                        done ? 'border-copper-300 bg-copper-500' : 'border-white/30'
                      }`}
                      aria-hidden="true"
                    />
                    <span className={`text-sm ${done ? 'text-cream-50' : 'text-cream-50/50'}`}>
                      {CUSTOMER_STEPS[key].label}
                    </span>
                  </li>
                );
              })}
            </ol>
          </GlassCard>

          {session.quote && <QuoteCard quote={session.quote} />}

          <p className="text-center text-xs text-cream-50/50">
            Confirmed bookings, documents and payments will appear here once our team has completed
            them with you.
          </p>
          <Link
            href="/concierge/chat"
            className="flex w-full items-center justify-center rounded-pill border border-copper-300 px-6 py-3 text-sm font-medium text-copper-100 hover:bg-emerald-700/40"
          >
            Continue the chat
          </Link>
        </div>
      )}
    </div>
  );
}
