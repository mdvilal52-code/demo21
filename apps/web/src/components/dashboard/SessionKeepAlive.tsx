'use client';

import { useEffect } from 'react';

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // access tokens live 15 minutes; refresh well before that

/**
 * Silently rotates the session's token pair while a staff member has the
 * dashboard open, so an active shift never gets cut off by the access
 * token's short TTL. Mounted once in the dashboard layout. If the refresh
 * ever fails (refresh token itself expired or revoked), this does nothing
 * further — the next page navigation hits the missing/expired cookie and
 * the layout's own auth gate redirects to `/login`, a real re-login
 * rather than a silently-faked session.
 */
export function SessionKeepAlive() {
  useEffect(() => {
    const interval = setInterval(() => {
      fetch('/api/session/refresh', { method: 'POST' }).catch(() => {
        // next navigation's auth gate handles a genuinely expired session
      });
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return null;
}
