import { listSecurityEvents, withTenantContext } from '@ai-concierge/db';
import { listSecurityEventsQuerySchema, listSecurityEventsResponseSchema } from '@ai-concierge/contracts';
import { Permission } from '@ai-concierge/domain';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authenticate } from '../../plugins/auth.js';
import { requirePermission } from '../../lib/authz.js';

/** The detection & response layer's read surface — today's T4 (Security/Compliance) escalation view, see docs/SECURITY-MODEL.md. */
export const securityEventRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/v1/security-events',
    {
      preHandler: [authenticate, requirePermission(Permission.SECURITY_EVENT_READ)],
      schema: {
        tags: ['admin'],
        querystring: listSecurityEventsQuerySchema,
        response: { 200: listSecurityEventsResponseSchema },
      },
    },
    async (request, reply) => {
      const items = await withTenantContext(app.ctx.prisma, request.auth!.tenantId, (tx) =>
        listSecurityEvents(tx, {
          tenantId: request.auth!.tenantId,
          limit: request.query.limit,
          ...(request.query.severity ? { severity: request.query.severity } : {}),
          ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        }),
      );
      const last = items.at(-1);
      reply.status(200).send({
        items: items.map((item) => ({
          id: item.id,
          userId: item.userId,
          type: item.type,
          severity: item.severity,
          ip: item.ip,
          userAgent: item.userAgent,
          metadata: item.metadata as Record<string, unknown>,
          createdAt: item.createdAt.toISOString(),
        })),
        nextCursor: items.length === request.query.limit ? (last?.id ?? null) : null,
      });
    },
  );
};
