import {
  checkAvailabilityParamsSchema,
  checkAvailabilityResponseSchema,
} from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { checkAvailability } from '../../services/availabilityService.js';

/**
 * Step 6 — Availability. Input is a Phase 1-3 conversation (already
 * validated, intent-recognized, dated, and vehicle-resolved); this never
 * accepts raw text or a request body directly.
 */
export const availabilityRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/enquiries/:conversationId/availability-check',
    {
      schema: {
        tags: ['availability'],
        params: checkAvailabilityParamsSchema,
        response: { 201: checkAvailabilityResponseSchema },
      },
    },
    async (request, reply) => {
      const response = await checkAvailability(
        { prisma: app.ctx.prisma, reservationLockService: app.ctx.reservationLockService },
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
