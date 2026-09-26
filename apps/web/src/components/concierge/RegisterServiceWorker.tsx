'use client';

import { useEffect } from 'react';

/**
 * Registers the offline-shell service worker for the customer app only (scope
 * `/concierge` — no trailing slash, so the app's own start page `/concierge` is
 * inside it as well as everything below it), and only in production so development hot-reload is never
 * fought by a cache. The worker never touches `/api/*` or the staff dashboard.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/concierge' }).catch(() => {
      // Installability is a bonus; the app works without it.
    });
  }, []);
  return null;
}
