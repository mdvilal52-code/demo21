import { z } from 'zod';

/** Mailgun expects a fast 200 ack; the body isn't Mailgun's business, but a real shape here is still useful for anyone testing the webhook by hand. */
export const emailInboundAckResponseSchema = z.object({
  received: z.boolean(),
});
export type EmailInboundAckResponse = z.infer<typeof emailInboundAckResponseSchema>;
