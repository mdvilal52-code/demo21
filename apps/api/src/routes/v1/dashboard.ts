import {
  dashboardSummaryResponseSchema,
  listQuotesQuerySchema,
  listQuotesResponseSchema,
  staffReplyBodySchema,
  staffReplyResponseSchema,
  transcriptParamsSchema,
  transcriptResponseSchema,
} from '@ai-concierge/contracts';
import { getDashboardSummary, listLatestQuotes } from '@ai-concierge/db';
import { Permission } from '@ai-concierge/domain';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requirePermission } from '../../lib/authz.js';
import { authenticate } from '../../plugins/auth.js';
import { sendStaffReply } from '../../services/staffReplyService.js';
import { getTranscript } from '../../services/transcriptService.js';

/**
 * The admin dashboard's remaining surfaces: Home's live numbers, the Quotes
 * screen, the conversation a human worker reads, and the human worker's own
 * reply. Reads are gated on `journey:read` (every staff tier already has it);
 * replying needs its own `conversation:reply` permission because it is the one
 * action here that speaks to a customer.
 */
export const dashboardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/v1/dashboard/summary',
    {
      preHandler: [authenticate, requirePermission(Permission.JOURNEY_READ)],
      schema: { tags: ['admin'], response: { 200: dashboardSummaryResponseSchema } },
    },
    async (request, reply) => {
      const summary = await getDashboardSummary(app.ctx.prisma, request.auth!.tenantId);
      reply.status(200).send({
        generatedAt: new Date().toISOString(),
        journeys: {
          total: summary.journeys.total,
          active: summary.journeys.active,
          byState: summary.journeys.byState as Array<{
            state: (typeof dashboardSummaryResponseSchema)['_output']['journeys']['byState'][number]['state'];
            count: number;
          }>,
        },
        escalations: summary.escalations,
        automation: summary.automation,
        quotes: summary.quotes,
        customers: summary.customers,
      });
    },
  );

  app.get(
    '/v1/quotes',
    {
      preHandler: [authenticate, requirePermission(Permission.JOURNEY_READ)],
      schema: {
        tags: ['admin'],
        querystring: listQuotesQuerySchema,
        response: { 200: listQuotesResponseSchema },
      },
    },
    async (request, reply) => {
      const rows = await listLatestQuotes(app.ctx.prisma, {
        tenantId: request.auth!.tenantId,
        limit: request.query.limit,
        offset: request.query.offset,
      });
      reply.status(200).send({
        items: rows.map((row) => ({
          quoteId: row.quoteId,
          version: row.version,
          status: row.status as 'ISSUED' | 'PENDING_REVIEW',
          conversationId: row.conversationId,
          channel: row.channel as 'WHATSAPP' | 'WEB' | 'EMAIL',
          customerRef: row.customerRef,
          vehicleName: row.vehicleName,
          currency: row.currency,
          total: row.total,
          deposit: row.deposit,
          validUntil: row.validUntil.toISOString(),
          createdAt: row.createdAt.toISOString(),
          requiresHumanReview: row.requiresHumanReview,
        })),
      });
    },
  );

  app.get(
    '/v1/enquiries/:conversationId/transcript',
    {
      preHandler: [authenticate, requirePermission(Permission.JOURNEY_READ)],
      schema: {
        tags: ['admin'],
        params: transcriptParamsSchema,
        response: { 200: transcriptResponseSchema },
      },
    },
    async (request, reply) => {
      const transcript = await getTranscript(
        { prisma: app.ctx.prisma },
        { tenantId: request.auth!.tenantId, conversationId: request.params.conversationId },
      );
      reply.status(200).send(transcript);
    },
  );

  app.post(
    '/v1/enquiries/:conversationId/staff-reply',
    {
      preHandler: [authenticate, requirePermission(Permission.CONVERSATION_REPLY)],
      schema: {
        tags: ['admin'],
        params: transcriptParamsSchema,
        body: staffReplyBodySchema,
        response: { 200: staffReplyResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await sendStaffReply(
        {
          prisma: app.ctx.prisma,
          whatsappProvider: app.ctx.whatsappProvider,
          emailProvider: app.ctx.emailProvider,
          logger: app.ctx.logger,
        },
        {
          tenantId: request.auth!.tenantId,
          userId: request.auth!.userId,
          conversationId: request.params.conversationId,
          message: request.body.message,
          requestId: request.id,
        },
      );
      reply.status(200).send(result);
    },
  );
};
