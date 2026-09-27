import { chatSessionIdSchema, getChatSessionResponseSchema } from '@ai-concierge/contracts';
import { NextResponse } from 'next/server';
import { backendFetch } from '../../../../../lib/backendFetch';

/** Public web chat, reading side: the conversation as the customer left it (including any team member's reply). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  const { sessionId } = await params;
  const parsedId = chatSessionIdSchema.safeParse(sessionId);
  if (!parsedId.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'Invalid session' } },
      { status: 400 },
    );
  }

  try {
    const upstream = await backendFetch(`/v1/chat/sessions/${parsedId.data}`);
    const payload: unknown = await upstream.json();
    if (!upstream.ok) return NextResponse.json(payload, { status: upstream.status });

    const session = getChatSessionResponseSchema.safeParse(payload);
    if (!session.success) throw new Error('Unexpected response shape from the concierge service');
    return NextResponse.json(session.data, {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      {
        error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The concierge is unavailable right now.' },
      },
      { status: 502 },
    );
  }
}
