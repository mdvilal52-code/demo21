import { z } from 'zod';

/** Meta's webhook verification handshake (GET) — field names are Meta's, dots included. */
export const whatsappVerifyQuerySchema = z.object({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
});
export type WhatsAppVerifyQuery = z.infer<typeof whatsappVerifyQuerySchema>;

/**
 * Meta expects a fast 200 ack; the body isn't Meta's business, but a real
 * shape here is still useful for anyone testing the webhook by hand.
 */
export const whatsappInboundAckResponseSchema = z.object({
  received: z.boolean(),
});
export type WhatsAppInboundAckResponse = z.infer<typeof whatsappInboundAckResponseSchema>;
