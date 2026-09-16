import {
  collectMissingInformationParamsSchema,
  collectMissingInformationResponseSchema,
} from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { collectMissingInformation } from '../../services/missingInformationService.js';

/**
 * Step 4 — Ask Missing Information. Input is a Phase 1-3 conversation
 * (already validated + intent-recognized + dates/location extracted +
 * vehicle determined); this never accepts raw text directly from the
 * request body — use POST .../messages to add a customer reply first, then
 * call this again to process it.
 */
export const missingInformationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/enquiries/:conversationId/missing-information',
    {
      schema: {
        tags: ['missing-information'],
        params: collectMissingInformationParamsSchema,
        response: { 201: collectMissingInformationResponseSchema },
      },
    },
    async (request, reply) => {
      const response = await collectMissingInformation(
        { prisma: app.ctx.prisma, engine: app.ctx.missingInformationEngine },
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
