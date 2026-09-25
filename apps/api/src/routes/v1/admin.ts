import {
  findCustomerById,
  findCustomerTimeline,
  listCustomers,
  listJourneys,
  listVehicles,
} from '@ai-concierge/db';
import {
  getCustomerParamsSchema,
  getCustomerResponseSchema,
  listCustomersQuerySchema,
  listCustomersResponseSchema,
  listJourneysQuerySchema,
  listJourneysResponseSchema,
  listVehiclesQuerySchema,
  listVehiclesResponseSchema,
  providerStatusResponseSchema,
} from '@ai-concierge/contracts';
import { AppError, Permission } from '@ai-concierge/domain';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authenticate } from '../../plugins/auth.js';
import { requirePermission } from '../../lib/authz.js';

/**
 * The admin dashboard's remaining read surfaces — Journeys list, Fleet,
 * Customers (CRM), and Settings' provider status. Gated on `journey:read`
 * (every staff tier already has it) rather than a new permission per
 * screen: none of this is more sensitive than the journey data that
 * permission already governs, and MASTER-PLAN.md's own escalation-tier
 * legend treats "tier" as a routing/paging concern, not a visibility wall
 * (see packages/domain/src/auth.ts's own doc on this).
 */
export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/v1/journeys',
    {
      preHandler: [authenticate, requirePermission(Permission.JOURNEY_READ)],
      schema: {
        tags: ['admin'],
        querystring: listJourneysQuerySchema,
        response: { 200: listJourneysResponseSchema },
      },
    },
    async (request, reply) => {
      const items = await listJourneys(app.ctx.prisma, {
        tenantId: request.auth!.tenantId,
        ...(request.query.state ? { state: request.query.state } : {}),
        limit: request.query.limit,
        offset: request.query.offset,
      });
      reply.status(200).send({ items });
    },
  );

  app.get(
    '/v1/vehicles',
    {
      preHandler: [authenticate, requirePermission(Permission.JOURNEY_READ)],
      schema: {
        tags: ['admin'],
        querystring: listVehiclesQuerySchema,
        response: { 200: listVehiclesResponseSchema },
      },
    },
    async (request, reply) => {
      const items = await listVehicles(app.ctx.prisma, {
        tenantId: request.auth!.tenantId,
        limit: request.query.limit,
        offset: request.query.offset,
      });
      reply.status(200).send({ items });
    },
  );

  app.get(
    '/v1/customers',
    {
      preHandler: [authenticate, requirePermission(Permission.CUSTOMER_READ)],
      schema: {
        tags: ['admin'],
        querystring: listCustomersQuerySchema,
        response: { 200: listCustomersResponseSchema },
      },
    },
    async (request, reply) => {
      const items = await listCustomers(app.ctx.prisma, {
        tenantId: request.auth!.tenantId,
        limit: request.query.limit,
        offset: request.query.offset,
      });
      reply.status(200).send({ items });
    },
  );

  app.get(
    '/v1/customers/:customerId',
    {
      preHandler: [authenticate, requirePermission(Permission.CUSTOMER_READ)],
      schema: {
        tags: ['admin'],
        params: getCustomerParamsSchema,
        response: { 200: getCustomerResponseSchema },
      },
    },
    async (request, reply) => {
      const customer = await findCustomerById(
        app.ctx.prisma,
        request.auth!.tenantId,
        request.params.customerId,
      );
      if (!customer) {
        throw new AppError('NOT_FOUND', 'Customer not found');
      }
      const timelineRows = await findCustomerTimeline(
        app.ctx.prisma,
        request.auth!.tenantId,
        customer.id,
      );
      reply.status(200).send({
        customer,
        timeline: timelineRows.map((row) => ({
          id: row.id,
          tenantId: row.tenantId,
          customerId: row.customerId,
          journeyId: row.journeyId,
          type: row.type,
          summary: row.summary,
          createdAt: row.createdAt.toISOString(),
        })),
      });
    },
  );

  app.get(
    '/v1/settings/providers',
    {
      preHandler: [authenticate, requirePermission(Permission.JOURNEY_READ)],
      schema: { tags: ['admin'], response: { 200: providerStatusResponseSchema } },
    },
    async (request, reply) => {
      reply.status(200).send({
        whatsapp: app.ctx.whatsappProviderStatus,
        email: app.ctx.emailProviderStatus,
        smsNotification: app.ctx.notificationProviderStatus,
        conversationalAi: app.ctx.aiProviderStatus,
        observability: app.ctx.observabilityStatus,
      });
    },
  );
};
