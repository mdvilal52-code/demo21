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
/** Most admin/API calls answer in milliseconds; a hung upstream should fail fast. */
const DEFAULT_TIMEOUT_MS = 10_000;

export async function backendFetch(
  path: string,
  init: RequestInit = {},
  options: { timeoutMs?: number } = {},
): Promise<Response> {
  const env = loadServerEnv();
  return ssrfSafeFetch(`${env.INTERNAL_API_BASE_URL}${path}`, env.OUTBOUND_ALLOWED_HOSTS, {
    ...init,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}
