import {
  recommendAlternativesParamsSchema,
  recommendAlternativesResponseSchema,
} from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { recommendAlternatives } from '../../services/alternativesService.js';

/**
 * Step 7 — Alternatives. Input is a Phase 1-3 conversation (already
 * validated, intent-recognized, dated, and vehicle-resolved); this never
 * accepts raw text or a request body directly.
 */
export const alternativesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/enquiries/:conversationId/alternatives',
    {
      schema: {
        tags: ['alternatives'],
        params: recommendAlternativesParamsSchema,
        response: { 201: recommendAlternativesResponseSchema },
      },
    },
    async (request, reply) => {
      const response = await recommendAlternatives(
        {
          prisma: app.ctx.prisma,
          orchestrator: app.ctx.alternativeRecommendationOrchestrator,
        },
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
