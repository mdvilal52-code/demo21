import {
  getChatSessionParamsSchema,
  getChatSessionResponseSchema,
  sendChatMessageBodySchema,
  sendChatMessageResponseSchema,
} from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getChatSession, sendChatMessage } from '../../services/chatService.js';

/**
 * Public customer web chat. No login: a customer is the unguessable session id
 * their browser generated. Reaches the API through the website's own server,
 * so every message shares the website's IP — the per-IP limiter is therefore
 * switched off for sending and replaced by per-session + whole-chat limits
 * (`enforceChatLimits`); the read endpoint keeps a generous per-IP cap.
 */
export const chatRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/chat/messages',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['chat'],
        body: sendChatMessageBodySchema,
        response: { 200: sendChatMessageResponseSchema },
      },
    },
    async (request, reply) => {
      const response = await sendChatMessage(app.ctx, request.body, request.id);
      reply.status(200).send(response);
    },
  );

  app.get(
    '/v1/chat/sessions/:sessionId',
    {
      config: { rateLimit: { max: 3000, timeWindow: 60_000 } },
      schema: {
        tags: ['chat'],
        params: getChatSessionParamsSchema,
        response: { 200: getChatSessionResponseSchema },
      },
    },
    async (request, reply) => {
      const response = await getChatSession(app.ctx, request.params.sessionId);
      reply.status(200).send(response);
    },
  );
};
