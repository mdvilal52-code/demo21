import { z } from 'zod';
import { chatSessionIdSchema } from './chat.js';

/**
 * The Gemini function-calling front door (`packages/ai`'s `engine/` module,
 * wired up in `apps/api/src/services/engineChatService.ts`). A separate
 * endpoint from `/v1/chat/messages`, not a replacement for it — see that
 * service's own doc comment for why Steps 1-8 keep running exactly as
 * before regardless of which functions this engine can call.
 */
export const engineIntentSchema = z.enum([
  'CONTINUE_BOOKING_FLOW',
  'ESCALATE_TO_HUMAN',
  'ANSWER_GENERAL_FAQ',
]);
export type EngineIntent = z.infer<typeof engineIntentSchema>;

export const sendEngineMessageBodySchema = z
  .object({
    sessionId: chatSessionIdSchema,
    clientMessageId: z.string().uuid(),
    message: z.string().trim().min(1).max(1000),
  })
  .strict();
export type SendEngineMessageBody = z.infer<typeof sendEngineMessageBodySchema>;

export const sendEngineMessageResponseSchema = z.object({
  conversationId: z.string().uuid(),
  /** Null when the model replied directly without picking a function. */
  intent: engineIntentSchema.nullable(),
  reply: z.object({
    text: z.string(),
    createdAt: z.string().datetime(),
  }),
  escalated: z.boolean(),
});
export type SendEngineMessageResponse = z.infer<typeof sendEngineMessageResponseSchema>;
