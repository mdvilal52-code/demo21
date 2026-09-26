'use client';

import { useEffect, useState } from 'react';
import { PillButton } from '../ui/PillButton';
import { StatusChip } from '../ui/StatusChip';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * "Add to home screen", done honestly for each platform: a real install button
 * where the browser offers one (Chrome/Edge/Android), the exact steps on iOS
 * (which has no install API), and a plain hint elsewhere.
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    setInstalled(window.matchMedia('(display-mode: standalone)').matches);
    setIos(/iphone|ipad|ipod/i.test(window.navigator.userAgent));

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed) return <StatusChip tone="success">Installed</StatusChip>;

  if (deferred) {
    return (
      <PillButton
        onClick={async () => {
          await deferred.prompt();
          const choice = await deferred.userChoice;
          if (choice.outcome === 'accepted') setInstalled(true);
          setDeferred(null);
        }}
      >
        Install the app
      </PillButton>
    );
  }

  return (
    <p className="text-sm text-cream-50/70" data-testid="install-hint">
      {ios
        ? 'On iPhone or iPad: tap the Share button, then “Add to Home Screen”.'
        : 'Use your browser’s menu and choose “Install app” or “Add to Home screen”.'}
    </p>
  );
}
