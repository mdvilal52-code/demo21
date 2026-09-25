import { z } from 'zod';

/**
 * Meta Cloud API webhook envelope — deliberately narrow and tolerant.
 * Meta also delivers delivery-status callbacks and non-text message types
 * (image, location, interactive, button, …) through this same endpoint, and
 * may add fields at any time; unknown/irrelevant shapes must parse to
 * "nothing to do here", never throw. Never trust external API input.
 */
const whatsappMessageSchema = z.object({
  from: z.string().min(1),
  id: z.string().min(1),
  type: z.string().min(1),
  text: z.object({ body: z.string() }).optional(),
});

const whatsappChangeValueSchema = z.object({
  messaging_product: z.string().optional(),
  metadata: z.object({ phone_number_id: z.string().optional() }).optional(),
  messages: z.array(whatsappMessageSchema).optional(),
  statuses: z.array(z.unknown()).optional(),
});

const whatsappChangeSchema = z.object({
  value: whatsappChangeValueSchema,
  field: z.string().optional(),
});

const whatsappEntrySchema = z.object({
  id: z.string().optional(),
  changes: z.array(whatsappChangeSchema).default([]),
});

export const whatsappWebhookPayloadSchema = z.object({
  object: z.string().optional(),
  entry: z.array(whatsappEntrySchema).default([]),
});

export type WhatsAppWebhookPayload = z.infer<typeof whatsappWebhookPayloadSchema>;

/** A single real customer text message, extracted and flattened out of the Meta envelope. */
export interface WhatsAppInboundText {
  messageId: string;
  from: string;
  body: string;
}
