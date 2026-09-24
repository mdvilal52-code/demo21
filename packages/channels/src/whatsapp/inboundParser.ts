import { whatsappWebhookPayloadSchema, type WhatsAppInboundText } from './types.js';

/**
 * Extracts only real customer text messages from a Meta webhook payload.
 * Delivery-status callbacks and non-text message types are silently
 * skipped — never crash the webhook ack over a shape we don't act on yet.
 * An unparseable payload yields zero messages rather than throwing.
 */
export function parseWhatsAppTextMessages(rawPayload: unknown): WhatsAppInboundText[] {
  const parsed = whatsappWebhookPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return [];

  const result: WhatsAppInboundText[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      for (const message of change.value.messages ?? []) {
        if (message.type === 'text' && message.text) {
          result.push({ messageId: message.id, from: message.from, body: message.text.body });
        }
      }
    }
  }
  return result;
}
