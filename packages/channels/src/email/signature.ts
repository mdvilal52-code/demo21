import { verifyWebhookSignature } from '@ai-concierge/security';

/**
 * Mailgun signs `timestamp + token` (concatenated, not the request body —
 * unlike Meta's X-Hub-Signature-256) with the account's webhook signing key.
 * A `token` is single-use in principle; replay protection here is the same
 * claim-before-work idempotency (keyed on Message-Id) the WhatsApp webhook
 * already established at the pipeline layer, not a timestamp-freshness
 * check on this function alone — Mailgun redelivers on a non-2xx response,
 * exactly like Meta does.
 */
export function verifyMailgunSignature(
  timestamp: string,
  token: string,
  signatureHex: string,
  signingKey: string,
): boolean {
  return verifyWebhookSignature(`${timestamp}${token}`, signatureHex, signingKey);
}
