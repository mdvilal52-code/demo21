import {
  postConversationReplyParamsSchema,
  postConversationReplyRequestSchema,
  postConversationReplyResponseSchema,
} from '@ai-concierge/contracts';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { postConversationReply } from '../../services/conversationReplyService.js';

/**
 * Appends a follow-up customer message to an existing conversation. This is
 * the only endpoint in the API that accepts raw customer text for an
 * *existing* conversation — Step 4's own endpoint below deliberately never
 * does, reading the stored message instead (same convention as Steps 2-3).
 */
export const conversationReplyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/enquiries/:conversationId/messages',
    {
      schema: {
        tags: ['enquiries'],
        params: postConversationReplyParamsSchema,
        body: postConversationReplyRequestSchema,
        response: { 201: postConversationReplyResponseSchema },
        headers: z.object({
          'idempotency-key': z.string().min(1).max(200).optional(),
        }),
      },
    },
    async (request, reply) => {
      const idempotencyKey = request.headers['idempotency-key'];
      const response = await postConversationReply(
        { prisma: app.ctx.prisma },
        {
          tenantId: app.ctx.config.DEFAULT_TENANT_ID,
          conversationId: request.params.conversationId,
          message: request.body.message,
          requestId: request.id,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      );
      reply.status(201).send(response);
    },
  );
};
