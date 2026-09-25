import { authTokenPairSchema } from '@ai-concierge/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { backendFetch } from '../../../../lib/backendFetch';
import {
  applySessionCookies,
  clearSessionCookies,
  readTokensFromRequest,
} from '../../../../lib/session';

/**
 * Rotates the token pair before the 15-minute access token expires.
 * Polled by `SessionKeepAlive` (mounted in the dashboard layout) while a
 * staff member has the tab open, so an active session never gets cut off
 * mid-shift — but a genuinely stale/revoked refresh token still fails
 * here and forces a real re-login, never a fake "still signed in".
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const { refreshToken } = readTokensFromRequest(request);
  if (!refreshToken) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'No active session' } },
      { status: 401 },
    );
  }

  try {
    const upstream = await backendFetch('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!upstream.ok) {
      const response = NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Session expired' } },
        { status: 401 },
      );
      clearSessionCookies(response);
      return response;
    }

    const tokens = authTokenPairSchema.parse(await upstream.json());
    const response = new NextResponse(null, { status: 204 });
    applySessionCookies(response, tokens);
    return response;
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'The auth service is unavailable right now',
        },
      },
      { status: 502 },
    );
  }
}
