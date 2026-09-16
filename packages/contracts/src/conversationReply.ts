import { z } from 'zod';
import { messageContentSchema } from '@ai-concierge/domain';

/**
 * Appends a follow-up customer message to an existing conversation — the
 * minimal capability Step 4's multi-turn loop needs to receive a reply
 * (no generic channel-adapter message ingestion exists yet; that is Phase
 * 5's WhatsApp/Web-chat/Email scope). Never accepts anything about intent,
 * dates, vehicle, etc. — this only stores the raw message; Step 4's own
 * endpoint is what reads and interprets it.
 */
export const postConversationReplyParamsSchema = z.object({
  conversationId: z.string().uuid(),
});
export type PostConversationReplyParams = z.infer<typeof postConversationReplyParamsSchema>;

export const postConversationReplyRequestSchema = z.object({
  message: messageContentSchema,
});
export type PostConversationReplyRequest = z.infer<typeof postConversationReplyRequestSchema>;

export const postConversationReplyResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
});
export type PostConversationReplyResponse = z.infer<typeof postConversationReplyResponseSchema>;
