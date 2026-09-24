import { verifyWebhookSignature } from '@ai-concierge/security';

const SIGNATURE_PREFIX = 'sha256=';
// A SHA-256 hex digest is always exactly 64 hex characters. Node's
// `Buffer.from(str, 'hex')` silently stops at the first invalid character
// instead of rejecting the string, so a well-formed 64-char signature with
// trailing garbage appended would otherwise still decode to the correct 32
// bytes and pass comparison. Not itself a forgery path (an attacker would
// already need the real signature to build such a string), but rejecting
// anything that isn't exactly 64 hex characters closes it outright.
const HEX_64_RE = /^[0-9a-f]{64}$/i;

/**
 * Meta signs the raw request body with the app's secret and sends
 * `X-Hub-Signature-256: sha256=<hex hmac>`. Verification must run against
 * the exact raw bytes Meta sent, never a re-serialized copy of the parsed
 * JSON (which is not guaranteed to be byte-identical).
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith(SIGNATURE_PREFIX)) return false;
  const signatureHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!HEX_64_RE.test(signatureHex)) return false;
  return verifyWebhookSignature(rawBody, signatureHex, appSecret);
}
