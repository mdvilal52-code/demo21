'use client';

import { useId, useState } from 'react';
import type { CreateEnquiryResponse, ErrorResponse } from '@ai-concierge/contracts';
import { GlassCard } from './ui/GlassCard';
import { PillButton } from './ui/PillButton';
import { IntentResult } from './IntentResult';

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; data: CreateEnquiryResponse }
  | { status: 'error'; message: string };

function getSessionCustomerRef(): string {
  if (typeof window === 'undefined') return 'server-render';
  const key = 'ai-concierge-customer-ref';
  const existing = window.sessionStorage.getItem(key);
  if (existing) return existing;
  const generated = crypto.randomUUID();
  window.sessionStorage.setItem(key, generated);
  return generated;
}

export function EnquiryForm() {
  const [message, setMessage] = useState('');
  const [state, setState] = useState<SubmitState>({ status: 'idle' });
  const messageId = useId();
  const statusId = useId();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) {
      setState({ status: 'error', message: 'Please tell us what you need before sending.' });
      return;
    }

    setState({ status: 'submitting' });
    try {
      const response = await fetch('/api/enquiries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'WEB',
          customerRef: getSessionCustomerRef(),
          message: trimmed,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const errorPayload = payload as ErrorResponse;
        setState({ status: 'error', message: errorPayload.error.message });
        return;
      }
      setState({ status: 'success', data: payload as CreateEnquiryResponse });
    } catch {
      setState({ status: 'error', message: 'Something went wrong. Please try again.' });
    }
  }

  return (
    <GlassCard className="w-full max-w-lg">
      <h1 className="font-display text-xl uppercase tracking-[0.14em] text-cream-50">
        AI Concierge
      </h1>
      <p className="mt-2 text-sm text-cream-50/70">
        Tell us what you need — dates, vehicle, location — and we&apos;ll take it from there.
      </p>

      <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
        <div>
          <label
            htmlFor={messageId}
            className="mb-2 block text-xs uppercase tracking-wide text-cream-50/70"
          >
            Your message
          </label>
          <textarea
            id={messageId}
            name="message"
            rows={4}
            maxLength={4000}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            className="w-full rounded-2xl border border-white/10 bg-emerald-900/60 p-3 text-sm text-cream-50 placeholder:text-cream-50/40 focus:border-copper-300 focus:outline-none"
            placeholder="e.g. I'd like to rent a Lamborghini in Dubai Marina from 15 to 19 October"
            aria-describedby={statusId}
          />
        </div>

        <PillButton type="submit" disabled={state.status === 'submitting'}>
          {state.status === 'submitting' ? 'Sending…' : 'Contact AI'}
        </PillButton>

        <div id={statusId} role="status" aria-live="polite">
          {state.status === 'error' && <p className="text-sm text-danger">{state.message}</p>}
          {state.status === 'success' && <IntentResult response={state.data} />}
        </div>
      </form>
    </GlassCard>
  );
}
