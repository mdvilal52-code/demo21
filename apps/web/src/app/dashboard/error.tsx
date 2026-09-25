'use client';

import { GlassCard } from '../../components/ui/GlassCard';
import { PillButton } from '../../components/ui/PillButton';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex justify-center py-16">
      <GlassCard className="w-full max-w-lg text-center">
        <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-cream-50/70">{error.message}</p>
        <PillButton className="mt-6" onClick={reset}>
          Try again
        </PillButton>
      </GlassCard>
    </div>
  );
}
