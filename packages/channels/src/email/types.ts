import { z } from 'zod';

/**
 * Mailgun inbound-routing webhook — a `multipart/form-data` POST, delivered
 * to Fastify as parsed fields (see apps/api/src/routes/webhooks/email.ts's
 * multipart handling). Deliberately narrow and tolerant, same posture as
 * `whatsappWebhookPayloadSchema`: Mailgun may add fields at any time, and a
 * malformed/partial payload must parse to "nothing to do here", never throw.
 * Field names are Mailgun's own (hyphenated, not camelCase) — never trust
 * external API input.
 */
export const mailgunInboundPayloadSchema = z.object({
  sender: z.string().min(1),
  recipient: z.string().min(1),
  subject: z.string().default(''),
  'body-plain': z.string().default(''),
  'stripped-text': z.string().optional(),
  'Message-Id': z.string().optional(),
  timestamp: z.string().min(1),
  token: z.string().min(1),
  signature: z.string().min(1),
});
export type MailgunInboundPayload = z.infer<typeof mailgunInboundPayloadSchema>;

/** A single real inbound customer email, extracted and flattened out of Mailgun's field names. */
export interface EmailInboundMessage {
  messageId: string;
  from: string;
  subject: string;
  body: string;
}
