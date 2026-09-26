import { sendChatMessageBodySchema, sendChatMessageResponseSchema } from '@ai-concierge/contracts';
import { NextResponse } from 'next/server';
import { backendFetch } from '../../../../lib/backendFetch';

/**
 * A chat turn can legitimately take a while: the automatic Steps 1-8 chain plus up to two Gemini
 * calls (each bounded at 8s by the API). Give it room here, and tell the host the function may
 * run that long (Vercel's default is 10s).
 */
export const maxDuration = 60;
const CHAT_TURN_TIMEOUT_MS = 50_000;

/**
 * Public web chat, sending side. The browser never talks to the API directly:
 * this route validates the body against the shared contract and relays it
 * server-to-server (the API's address stays private, and a malformed request
 * never leaves this process).
 */
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

  const parsed = sendChatMessageBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Please write a message of 1 to 1,000 characters.',
        },
      },
      { status: 400 },
    );
  }

  try {
    const upstream = await backendFetch(
      '/v1/chat/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      },
      { timeoutMs: CHAT_TURN_TIMEOUT_MS },
    );
    const payload: unknown = await upstream.json();
    if (!upstream.ok) return NextResponse.json(payload, { status: upstream.status });

    const reply = sendChatMessageResponseSchema.safeParse(payload);
    if (!reply.success) throw new Error('Unexpected response shape from the concierge service');
    return NextResponse.json(reply.data, { status: 200 });
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'The concierge is unavailable right now. Please try again in a moment.',
        },
      },
      { status: 502 },
    );
  }
}
