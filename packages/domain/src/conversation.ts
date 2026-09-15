import { z } from 'zod';
import { tenantIdSchema } from './tenant.js';

export const Channel = { WHATSAPP: 'WHATSAPP', WEB: 'WEB', EMAIL: 'EMAIL' } as const;
export const channelSchema = z.enum([Channel.WHATSAPP, Channel.WEB, Channel.EMAIL]);
export type ChannelValue = z.infer<typeof channelSchema>;

/** Upper bound enforced at every boundary (API schema, engine, DB column). */
export const MAX_MESSAGE_LENGTH = 4000;

export const messageContentSchema = z
  .string()
  .trim()
  .min(1, 'Message cannot be empty')
  .max(MAX_MESSAGE_LENGTH, `Message cannot exceed ${MAX_MESSAGE_LENGTH} characters`);

export const conversationSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  channel: channelSchema,
  customerRef: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  processedAt: z.string().datetime().nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const messageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  content: messageContentSchema,
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof messageSchema>;
