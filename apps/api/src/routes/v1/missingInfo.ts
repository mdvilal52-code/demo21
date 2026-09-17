import {
  checkMissingInfoParamsSchema,
  checkMissingInfoResponseSchema,
} from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { checkMissingInfo } from '../../services/missingInfoService.js';

/**
 * Step 4 — Ask Missing Information. Input is a conversation (already
 * processed by Steps 1-3, as much or as little as has happened so far);
 * this never accepts raw text directly from the request body.
 */
export const missingInfoRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/enquiries/:conversationId/missing-info',
    {
      schema: {
        tags: ['missing-info'],
        params: checkMissingInfoParamsSchema,
        response: { 201: checkMissingInfoResponseSchema },
      },
    },
    async (request, reply) => {
      const response = await checkMissingInfo(
        { prisma: app.ctx.prisma, orchestrator: app.ctx.missingInfoOrchestrator },
        {
          tenantId: app.ctx.config.DEFAULT_TENANT_ID,
          conversationId: request.params.conversationId,
          requestId: request.id,
        },
      );
      reply.status(201).send(response);
    },
  );
};
