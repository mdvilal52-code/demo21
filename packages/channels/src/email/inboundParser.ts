import { mailgunInboundPayloadSchema, type EmailInboundMessage } from './types.js';

/**
 * Extracts a real inbound email from a Mailgun payload. An unparseable
 * payload yields `null` rather than throwing — same "never crash the
 * webhook ack over a shape we don't recognize" posture as
 * `parseWhatsAppTextMessages`. Signature verification happens separately,
 * before this is ever called (see the webhook route) — this function only
 * shapes an already-authenticated payload.
 */
export function parseMailgunInboundEmail(rawPayload: unknown): EmailInboundMessage | null {
  const parsed = mailgunInboundPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return null;

  const body = parsed.data['stripped-text']?.trim() || parsed.data['body-plain'].trim();
  if (!body) return null;

  return {
    messageId: parsed.data['Message-Id'] ?? `${parsed.data.timestamp}:${parsed.data.token}`,
    from: parsed.data.sender,
    subject: parsed.data.subject,
    body,
  };
}
