import { authTokenPairSchema, loginRequestSchema } from '@ai-concierge/contracts';
import { NextResponse } from 'next/server';
import { backendFetch } from '../../../../lib/backendFetch';
import { applySessionCookies } from '../../../../lib/session';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'Request body must be valid JSON' } },
      { status: 400 },
    );
  }

  const parsed = loginRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request failed schema validation',
          details: { issues: parsed.error.issues },
        },
      },
      { status: 400 },
    );
  }

  try {
    const upstream = await backendFetch('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
    const payload: unknown = await upstream.json();
    if (!upstream.ok) {
      return NextResponse.json(payload, { status: upstream.status });
    }

    const tokens = authTokenPairSchema.parse(payload);
    const response = NextResponse.json({ user: tokens.user }, { status: 200 });
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
