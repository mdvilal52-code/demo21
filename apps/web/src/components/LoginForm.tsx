'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ErrorResponse } from '@ai-concierge/contracts';
import { GlassCard } from './ui/GlassCard';
import { PillButton } from './ui/PillButton';

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'mfaRequired'; message: string }
  | { status: 'error'; message: string };

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [state, setState] = useState<SubmitState>({ status: 'idle' });
  const emailId = useId();
  const passwordId = useId();
  const mfaId = useId();
  const statusId = useId();

  const mfaRequired = state.status === 'mfaRequired';

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: 'submitting' });
    try {
      const response = await fetch('/api/session/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password,
          ...(mfaRequired && mfaCode ? { mfaCode } : {}),
        }),
      });

      if (response.ok) {
        router.push('/dashboard');
        router.refresh();
        return;
      }

      const payload = (await response.json()) as ErrorResponse;
      if (payload.error.details?.mfaRequired) {
        setState({
          status: 'mfaRequired',
          message: 'Enter the 6-digit code from your authenticator app.',
        });
        return;
      }
      setState({ status: 'error', message: payload.error.message });
    } catch {
      setState({ status: 'error', message: 'Something went wrong. Please try again.' });
    }
  }

  return (
    <GlassCard className="w-full max-w-sm">
      <h1 className="font-display text-xl uppercase tracking-[0.14em] text-cream-50">Sign in</h1>
      <p className="mt-2 text-sm text-cream-50/70">Staff access to the AI Concierge dashboard.</p>

      <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
        <div>
          <label
            htmlFor={emailId}
            className="mb-2 block text-xs uppercase tracking-wide text-cream-50/70"
          >
            Email
          </label>
          <input
            id={emailId}
            name="email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-2xl border border-white/10 bg-emerald-900/60 p-3 text-sm text-cream-50 placeholder:text-cream-50/40 focus:border-copper-300 focus:outline-none"
            placeholder="you@company.com"
          />
        </div>

        <div>
          <label
            htmlFor={passwordId}
            className="mb-2 block text-xs uppercase tracking-wide text-cream-50/70"
          >
            Password
          </label>
          <input
            id={passwordId}
            name="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-2xl border border-white/10 bg-emerald-900/60 p-3 text-sm text-cream-50 placeholder:text-cream-50/40 focus:border-copper-300 focus:outline-none"
            placeholder="••••••••"
          />
        </div>

        {mfaRequired && (
          <div>
            <label
              htmlFor={mfaId}
              className="mb-2 block text-xs uppercase tracking-wide text-cream-50/70"
            >
              Authentication code
            </label>
            <input
              id={mfaId}
              name="mfaCode"
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              required
              autoComplete="one-time-code"
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, ''))}
              className="w-full rounded-2xl border border-white/10 bg-emerald-900/60 p-3 text-center text-lg tracking-[0.3em] text-cream-50 placeholder:text-cream-50/40 focus:border-copper-300 focus:outline-none"
              placeholder="000000"
            />
          </div>
        )}

        <PillButton type="submit" className="w-full" disabled={state.status === 'submitting'}>
          {state.status === 'submitting' ? 'Signing in…' : mfaRequired ? 'Verify' : 'Sign in'}
        </PillButton>

        <div id={statusId} role="status" aria-live="polite">
          {state.status === 'error' && <p className="text-sm text-danger">{state.message}</p>}
          {state.status === 'mfaRequired' && (
            <p className="text-sm text-warning">{state.message}</p>
          )}
        </div>
      </form>
    </GlassCard>
  );
}
