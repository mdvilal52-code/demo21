import { sendEngineMessageBodySchema, sendEngineMessageResponseSchema } from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sendEngineMessage } from '../../services/engineChatService.js';

/**
 * The Gemini function-calling front door (see `engineChatService.ts`'s own
 * doc comment) — a separate, additive endpoint from `/v1/chat/messages`,
 * not a replacement for it. Same no-login/session-id/rate-limit shape as
 * `chatRoutes` (`chat.ts`), deliberately kept identical so the two are easy
 * to compare and safe to run side by side.
 */
export const engineRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/engine/messages',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['engine'],
        body: sendEngineMessageBodySchema,
        response: { 200: sendEngineMessageResponseSchema },
      },
    },
    async (request, reply) => {
      const response = await sendEngineMessage(app.ctx, request.body, request.id);
      reply.status(200).send(response);
    },
  );
};
