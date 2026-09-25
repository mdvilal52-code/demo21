import 'server-only';
import { ssrfSafeFetch } from '@ai-concierge/security';
import { loadServerEnv } from './env';

/**
 * Every server-side call from this app to the API goes through here —
 * same allowlisted-host, timeout-bounded `ssrfSafeFetch` the original
 * `/api/enquiries` route established, just factored out now that session
 * routes, Server Components, and Server Actions all need the identical
 * base-URL + allowlist wiring instead of repeating it at each call site.
 */
export async function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const env = loadServerEnv();
  return ssrfSafeFetch(`${env.INTERNAL_API_BASE_URL}${path}`, env.OUTBOUND_ALLOWED_HOSTS, {
    ...init,
    timeoutMs: 10_000,
  });
}
