import {
  extractDatesLocationParamsSchema,
  extractDatesLocationResponseSchema,
} from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { extractDatesAndLocation } from '../../services/dateLocationService.js';

/**
 * Step 2 — Extract Dates & Location. Input is a Phase 1 conversation
 * (already validated + intent-recognized); this never accepts raw text
 * directly from the request body.
 */
export const temporalRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/enquiries/:conversationId/dates-location',
    {
      schema: {
        tags: ['temporal'],
        params: extractDatesLocationParamsSchema,
        response: { 201: extractDatesLocationResponseSchema },
      },
    },
    async (request, reply) => {
      const response = await extractDatesAndLocation(
        { prisma: app.ctx.prisma, orchestrator: app.ctx.dateLocationOrchestrator },
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
