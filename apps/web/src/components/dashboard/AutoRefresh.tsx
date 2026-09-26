'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Keeps a dashboard screen live without a page reload: re-runs the Server
 * Components (fresh data from the API) on an interval while the tab is
 * visible, and immediately when the tab becomes visible again. Client state on
 * the page — a half-typed reply, say — survives a refresh. A plain polling
 * refresh, not SSE: it works on every host (including serverless) and is
 * honest about being a refresh rather than a push.
 */
export function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  useEffect(() => {
    const stamp = () => setRefreshedAt(new Date().toLocaleTimeString('en-GB'));
    stamp();
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      router.refresh();
      stamp();
    };
    const timer = window.setInterval(refresh, intervalMs);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [router, intervalMs]);

  return (
    <p className="flex items-center gap-2 text-xs text-cream-50/50" data-testid="auto-refresh">
      <span
        className="inline-block h-2 w-2 animate-pulse rounded-full bg-success"
        aria-hidden="true"
      />
      Live{refreshedAt ? ` · refreshed ${refreshedAt}` : ''}
    </p>
  );
}
