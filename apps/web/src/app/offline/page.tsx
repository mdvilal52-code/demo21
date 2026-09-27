import { Monogram } from '../../components/ui/Monogram';
import { ReloadButton } from './ReloadButton';

export const metadata = { title: 'Offline · AI Concierge' };

/** Precached by the service worker and shown when a page cannot be reached. */
export default function OfflinePage() {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-6 text-center">
      <Monogram />
      <h1 className="font-display text-lg uppercase tracking-[0.18em] text-cream-50">
        You are offline
      </h1>
      <p className="max-w-xs text-sm text-cream-50/70">
        The concierge needs a connection. Reconnect and your conversation will be right where you
        left it.
      </p>
      <ReloadButton />
    </main>
  );
}
