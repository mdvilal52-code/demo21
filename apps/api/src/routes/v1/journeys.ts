import { getJourneyParamsSchema, getJourneyResponseSchema } from '@ai-concierge/contracts';
import { Permission } from '@ai-concierge/domain';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authenticate } from '../../plugins/auth.js';
import { requirePermission } from '../../lib/authz.js';
import { getJourney } from '../../services/journeyService.js';

/** The admin dashboard's Journeys screen backend — current state + full timeline for one conversation. */
export const journeyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/v1/enquiries/:conversationId/journey',
    {
      preHandler: [authenticate, requirePermission(Permission.JOURNEY_READ)],
      schema: {
        tags: ['admin'],
        params: getJourneyParamsSchema,
        response: { 200: getJourneyResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await getJourney(
        { prisma: app.ctx.prisma, notificationProvider: app.ctx.notificationProvider },
        { tenantId: request.auth!.tenantId, conversationId: request.params.conversationId },
      );
      reply.status(200).send(result);
    },
  );
};
