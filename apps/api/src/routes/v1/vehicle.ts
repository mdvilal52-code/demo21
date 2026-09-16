import {
  determineVehicleParamsSchema,
  determineVehicleResponseSchema,
} from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { determineVehicle } from '../../services/vehicleService.js';

/**
 * Step 3 — Determine Vehicle. Input is a Phase 1/2 conversation (already
 * validated + intent-recognized); this never accepts raw text directly
 * from the request body.
 */
export const vehicleRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/enquiries/:conversationId/vehicle-selection',
    {
      schema: {
        tags: ['vehicle'],
        params: determineVehicleParamsSchema,
        response: { 201: determineVehicleResponseSchema },
      },
    },
    async (request, reply) => {
      const response = await determineVehicle(
        { prisma: app.ctx.prisma, orchestrator: app.ctx.vehicleOrchestrator },
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
