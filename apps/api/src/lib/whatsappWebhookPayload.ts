import { z } from 'zod';

// Models only the fields this adapter reads from Meta's webhook payload.
// `.passthrough()` at every level tolerates fields Meta adds later (contact
// profile names, richer metadata, …) without rejecting the whole delivery.
const whatsappInboundMessageSchema = z
  .object({
    from: z.string().min(1).max(50),
    id: z.string().min(1).max(200),
    timestamp: z.string().min(1).max(50),
    type: z.string().min(1).max(50),
    text: z.object({ body: z.string() }).passthrough().optional(),
  })
  .passthrough();

const whatsappChangeValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    messages: z.array(whatsappInboundMessageSchema).optional(),
    statuses: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const whatsappWebhookPayloadSchema = z
  .object({
    object: z.string().optional(),
    entry: z
      .array(
        z
          .object({
            changes: z
              .array(z.object({ value: whatsappChangeValueSchema }).passthrough())
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type WhatsAppWebhookPayload = z.infer<typeof whatsappWebhookPayloadSchema>;

export interface InboundWhatsAppMessage {
  /** Sender's WhatsApp ID (E.164 phone number, no leading `+`). */
  from: string;
  /** Meta's message id (`wamid...`) — the natural duplicate-delivery key. */
  id: string;
  type: string;
  /** Populated only when `type === 'text'`; every other type is `null` here. */
  text: string | null;
}

/**
 * Flattens `entry[].changes[].value.messages[]` across the whole payload.
 * `statuses[]` entries (delivery receipts for our own outbound sends) live
 * in the same `value` object under a different key and are simply absent
 * from the result — this never reads them.
 */
export function extractInboundMessages(payload: WhatsAppWebhookPayload): InboundWhatsAppMessage[] {
  const messages: InboundWhatsAppMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value.messages ?? []) {
        messages.push({
          from: message.from,
          id: message.id,
          type: message.type,
          text: message.type === 'text' ? (message.text?.body ?? null) : null,
        });
      }
    }
  }
  return messages;
}
