import {
  escalationCaseParamsSchema,
  escalationCaseResponseSchema,
  listEscalationsQuerySchema,
  listEscalationsResponseSchema,
  resolveEscalationBodySchema,
} from '@ai-concierge/contracts';
import { Permission } from '@ai-concierge/domain';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authenticate } from '../../plugins/auth.js';
import { requirePermission } from '../../lib/authz.js';
import {
  assignEscalation,
  listEscalations,
  resolveEscalation,
} from '../../services/escalationService.js';

/**
 * The dashboard's Escalation Queue backend — where the human half of "AI
 * kaam nahi kar paye toh human worker ko sms kar de" actually happens: a
 * worker sees the case (they were already paged by SMS when it was
 * created — journeyService.ts's `pageTier`), assigns it to themselves, and
 * resolves it. Every staff tier (T2/T3/T4) can see and act on every case —
 * `EscalationCase.tier` is a routing/paging concern, not a visibility wall
 * (see `Permission`'s own doc in packages/domain/src/auth.ts).
 */
export const escalationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/v1/escalations',
    {
      preHandler: [authenticate, requirePermission(Permission.ESCALATION_READ)],
      schema: {
        tags: ['admin'],
        querystring: listEscalationsQuerySchema,
        response: { 200: listEscalationsResponseSchema },
      },
    },
    async (request, reply) => {
      const items = await listEscalations(
        { prisma: app.ctx.prisma },
        {
          tenantId: request.auth!.tenantId,
          ...(request.query.status ? { status: request.query.status } : {}),
          limit: request.query.limit,
          offset: request.query.offset,
        },
      );
      reply.status(200).send({ items });
    },
  );

  app.post(
    '/v1/escalations/:escalationCaseId/assign',
    {
      preHandler: [authenticate, requirePermission(Permission.ESCALATION_ASSIGN)],
      schema: {
        tags: ['admin'],
        params: escalationCaseParamsSchema,
        response: { 200: escalationCaseResponseSchema },
      },
    },
    async (request, reply) => {
      const escalationCase = await assignEscalation(
        { prisma: app.ctx.prisma },
        {
          tenantId: request.auth!.tenantId,
          escalationCaseId: request.params.escalationCaseId,
          assignedToUserId: request.auth!.userId,
          requestId: request.id,
        },
      );
      reply.status(200).send({ escalationCase });
    },
  );

  app.post(
    '/v1/escalations/:escalationCaseId/resolve',
    {
      preHandler: [authenticate, requirePermission(Permission.ESCALATION_RESOLVE)],
      schema: {
        tags: ['admin'],
        params: escalationCaseParamsSchema,
        body: resolveEscalationBodySchema,
        response: { 200: escalationCaseResponseSchema },
      },
    },
    async (request, reply) => {
      const escalationCase = await resolveEscalation(
        { prisma: app.ctx.prisma },
        {
          tenantId: request.auth!.tenantId,
          escalationCaseId: request.params.escalationCaseId,
          resolvedByUserId: request.auth!.userId,
          requestId: request.id,
          resolution: request.body.resolution,
          resolutionNote: request.body.resolutionNote,
        },
      );
      reply.status(200).send({ escalationCase });
    },
  );
};
