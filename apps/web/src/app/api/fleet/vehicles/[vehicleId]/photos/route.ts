import { uploadVehiclePhotoQuerySchema, vehiclePhotoResponseSchema } from '@ai-concierge/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { backendFetch } from '../../../../../../lib/backendFetch';
import { readTokensFromRequest } from '../../../../../../lib/session';

/** A resized photo is a few hundred KB; the API refuses anything over 4 MB regardless. */
export const maxDuration = 30;

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Staff photo upload. The browser posts the image bytes here (its session
 * cookie proves who is uploading); this route relays them, with the caller's
 * access token, to the API — which checks the permission again and verifies
 * the bytes really are an image. The API's address and the token never reach
 * the browser.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ vehicleId: string }> },
): Promise<NextResponse> {
  const { vehicleId } = await context.params;
  if (!UUID.test(vehicleId)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'Unknown vehicle' } },
      { status: 400 },
    );
  }

  const { accessToken } = readTokensFromRequest(request);
  if (!accessToken) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Sign in again' } },
      { status: 401 },
    );
  }

  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim();
  if (!ALLOWED_TYPES.has(contentType)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'Choose a JPEG, PNG or WebP photo' } },
      { status: 400 },
    );
  }

  const query = uploadVehiclePhotoQuerySchema.safeParse({
    caption: request.nextUrl.searchParams.get('caption') || undefined,
  });
  if (!query.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'The caption is too long' } },
      { status: 400 },
    );
  }

  const bytes = await request.arrayBuffer();
  const search = query.data.caption ? `?caption=${encodeURIComponent(query.data.caption)}` : '';
  try {
    const upstream = await backendFetch(
      `/v1/fleet/vehicles/${vehicleId}/photos${search}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': contentType },
        body: bytes,
      },
      { timeoutMs: 25_000 },
    );
    const payload: unknown = await upstream.json().catch(() => null);
    if (upstream.ok) {
      const parsed = vehiclePhotoResponseSchema.safeParse(payload);
      if (parsed.success) return NextResponse.json(parsed.data, { status: 201 });
    }
    const message =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      payload.error &&
      typeof payload.error === 'object' &&
      'message' in payload.error &&
      typeof payload.error.message === 'string'
        ? payload.error.message
        : 'The photo could not be saved';
    return NextResponse.json(
      { error: { code: 'UPLOAD_FAILED', message } },
      { status: upstream.ok ? 502 : upstream.status },
    );
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The service is unavailable right now' } },
      { status: 502 },
    );
  }
}
