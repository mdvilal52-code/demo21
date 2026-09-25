import 'server-only';
import type { AuthTokenPair } from '@ai-concierge/contracts';
import type { NextRequest, NextResponse } from 'next/server';

/**
 * Two httpOnly cookies hold the token pair `POST /v1/auth/login` returns —
 * never exposed to client-side JS, so an XSS bug in this app can't read
 * them off `document.cookie`. `sameSite: 'lax'` is this app's CSRF defense
 * for the mutating Server Actions (escalation assign/resolve): a
 * cross-site POST never carries a Lax cookie, so the backend never sees a
 * forged request authenticated as a signed-in staff member.
 */
const ACCESS_TOKEN_COOKIE = 'ac_access_token';
const REFRESH_TOKEN_COOKIE = 'ac_refresh_token';

function cookieOptions(expiresAt: string) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    expires: new Date(expiresAt),
  };
}

/** Called from a Route Handler after a successful login or refresh. */
export function applySessionCookies(response: NextResponse, tokens: AuthTokenPair): void {
  response.cookies.set(
    ACCESS_TOKEN_COOKIE,
    tokens.accessToken,
    cookieOptions(tokens.accessTokenExpiresAt),
  );
  response.cookies.set(
    REFRESH_TOKEN_COOKIE,
    tokens.refreshToken,
    cookieOptions(tokens.refreshTokenExpiresAt),
  );
}

/** Called from a Route Handler on logout, or when a refresh attempt fails. */
export function clearSessionCookies(response: NextResponse): void {
  response.cookies.delete(ACCESS_TOKEN_COOKIE);
  response.cookies.delete(REFRESH_TOKEN_COOKIE);
}

/** Read inside a Route Handler, which gets cookies off the request object directly. */
export function readTokensFromRequest(request: NextRequest): {
  accessToken: string | null;
  refreshToken: string | null;
} {
  return {
    accessToken: request.cookies.get(ACCESS_TOKEN_COOKIE)?.value ?? null,
    refreshToken: request.cookies.get(REFRESH_TOKEN_COOKIE)?.value ?? null,
  };
}

/** Read inside a Server Component or Server Action via `next/headers`' cookie jar. */
export async function readTokensFromCookieStore(): Promise<{
  accessToken: string | null;
  refreshToken: string | null;
}> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  return {
    accessToken: store.get(ACCESS_TOKEN_COOKIE)?.value ?? null,
    refreshToken: store.get(REFRESH_TOKEN_COOKIE)?.value ?? null,
  };
}
