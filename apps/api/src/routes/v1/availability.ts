import {
  checkAvailabilityParamsSchema,
  checkAvailabilityResponseSchema,
} from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { checkAvailability } from '../../services/availabilityService.js';
import { recordAvailabilityOutcome } from '../../services/journeyService.js';

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

      // Best-effort journey tracking/escalation — never fails the already-computed,
      // already-persisted availability result above (see journeyService.ts's module doc).
      try {
        await recordAvailabilityOutcome(
          { prisma: app.ctx.prisma, notificationProvider: app.ctx.notificationProvider },
          {
            tenantId: app.ctx.config.DEFAULT_TENANT_ID,
            conversationId: request.params.conversationId,
            status: response.availability.status,
            retryable: response.availability.retryable,
            reason: response.availability.reason ?? null,
            requestId: request.id,
          },
        );
      } catch (error) {
        app.log.error({ err: error }, 'journey sync failed after availability check');
      }

      reply.status(201).send(response);
    },
  );
};
