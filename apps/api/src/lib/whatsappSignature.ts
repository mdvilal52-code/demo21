import { verifyWebhookSignature } from '@ai-concierge/security';

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Meta sends `X-Hub-Signature-256: sha256=<hex>`, HMAC'd over the exact raw
 * request body. Wraps the generic verifier with that header encoding, as
 * webhookSignature.ts's own doc comment anticipates per-provider adapters
 * doing.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | string[] | undefined,
  appSecret: string,
): boolean {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const signatureHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  return verifyWebhookSignature(rawBody, signatureHex, appSecret);
}
