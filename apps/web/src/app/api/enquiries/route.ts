import { createEnquiryRequestSchema } from '@ai-concierge/contracts';
import { ssrfSafeFetch } from '@ai-concierge/security';
import { NextResponse } from 'next/server';
import { loadServerEnv } from '../../../lib/env';

export async function POST(request: Request): Promise<NextResponse> {
  const env = loadServerEnv();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'Request body must be valid JSON' } },
      { status: 400 },
    );
  }

  const parsed = createEnquiryRequestSchema.safeParse(body);
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
    const upstream = await ssrfSafeFetch(
      `${env.INTERNAL_API_BASE_URL}/v1/enquiries`,
      env.OUTBOUND_ALLOWED_HOSTS,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
        timeoutMs: 10_000,
      },
    );
    const payload: unknown = await upstream.json();
    return NextResponse.json(payload, { status: upstream.status });
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'The concierge service is unavailable right now',
        },
      },
      { status: 502 },
    );
  }
}
