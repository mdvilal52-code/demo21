import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Generic HMAC-SHA256 webhook signing/verification. Channel adapters
 * (WhatsApp, payment providers, …) wrap this with their provider's specific
 * header name and encoding in later phases; Phase 1 ships the primitive and
 * proves it is constant-time and rejects tampering.
 */
export function signWebhookPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export function verifyWebhookSignature(
  payload: string,
  signatureHex: string,
  secret: string,
): boolean {
  const expected = signWebhookPayload(payload, secret);
  const expectedBuffer = Buffer.from(expected, 'hex');
  let providedBuffer: Buffer;
  try {
    providedBuffer = Buffer.from(signatureHex, 'hex');
  } catch {
    return false;
  }
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}
