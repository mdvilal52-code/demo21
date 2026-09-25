import { NextResponse, type NextRequest } from 'next/server';
import { backendFetch } from '../../../../lib/backendFetch';
import { clearSessionCookies, readTokensFromRequest } from '../../../../lib/session';

/**
 * Always clears the local session cookies, even if the upstream call fails
 * or there was no refresh token to revoke — a stuck "can't log out" state
 * would be worse than an unrevoked-but-expiring refresh token.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const { refreshToken } = readTokensFromRequest(request);

  if (refreshToken) {
    try {
      await backendFetch('/v1/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // best-effort revoke; the cookies are cleared below regardless
    }
  }

  const response = new NextResponse(null, { status: 204 });
  clearSessionCookies(response);
  return response;
}
