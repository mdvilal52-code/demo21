import 'server-only';
import { authenticatedUserSchema, type AuthenticatedUser } from '@ai-concierge/domain';
import { backendFetch } from './backendFetch';
import { readTokensFromCookieStore } from './session';

/**
 * The dashboard's auth gate — called from the `(dashboard)` layout Server
 * Component on every request. Returns `null` for "not signed in" (missing
 * cookie, expired/revoked token, or the API unreachable); the layout
 * redirects to `/login` on `null` rather than rendering anything, so no
 * dashboard screen can ever render without a genuinely-verified session.
 */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const { accessToken } = await readTokensFromCookieStore();
  if (!accessToken) return null;

  try {
    const upstream = await backendFetch('/v1/auth/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!upstream.ok) return null;
    const parsed = authenticatedUserSchema.safeParse(await upstream.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
