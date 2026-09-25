import { listAuditEvents, recordSecurityEvent } from '@ai-concierge/db';
import { listAuditEventsResponseSchema, listQuerySchema } from '@ai-concierge/contracts';
import { Permission, SecurityEventType, SecuritySeverity } from '@ai-concierge/domain';
import { withTenantContext } from '@ai-concierge/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authenticate } from '../../plugins/auth.js';
import { requirePermission } from '../../lib/authz.js';
import { recordListAccessAndCheckMassExport } from '../../lib/anomalyDetection.js';

/** Phase 7's Audit log screen's read path (MASTER-PLAN.md §5.7) — first exposed here, behind AuthZ, ahead of that UI existing. */
export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/v1/audit-events',
    {
      preHandler: [authenticate, requirePermission(Permission.AUDIT_EVENT_READ)],
      schema: {
        tags: ['admin'],
        querystring: listQuerySchema,
        response: { 200: listAuditEventsResponseSchema },
      },
    },
    async (request, reply) => {
      const massExportSuspected = await recordListAccessAndCheckMassExport(
        app.ctx.redis,
        request.auth!.tenantId,
        request.auth!.userId,
        'audit_events',
      );
      const items = await withTenantContext(app.ctx.prisma, request.auth!.tenantId, async (tx) => {
        if (massExportSuspected) {
          await recordSecurityEvent(tx, {
            tenantId: request.auth!.tenantId,
            userId: request.auth!.userId,
            type: SecurityEventType.ANOMALY_MASS_EXPORT,
            severity: SecuritySeverity.WARNING,
            metadata: { resource: 'audit_events' },
          });
        }
        return listAuditEvents(tx, {
          tenantId: request.auth!.tenantId,
          limit: request.query.limit,
          ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        });
      });
      const last = items.at(-1);
      reply.status(200).send({
        items: items.map((item) => ({
          id: item.id,
          actor: item.actor,
          action: item.action,
          entityType: item.entityType,
          entityId: item.entityId,
          before: item.before as Record<string, unknown> | null,
          after: item.after as Record<string, unknown> | null,
          requestId: item.requestId,
          ip: item.ip,
          createdAt: item.createdAt.toISOString(),
        })),
        nextCursor: items.length === request.query.limit ? (last?.id ?? null) : null,
      });
    },
  );
};
