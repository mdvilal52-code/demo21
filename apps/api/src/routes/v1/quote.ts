import {
  createQuoteBodySchema,
  createQuoteParamsSchema,
  createQuoteResponseSchema,
  getQuoteParamsSchema,
  getQuoteResponseSchema,
} from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createQuote, getQuote } from '../../services/quoteService.js';

/**
 * Step 8 — Quote. Input is a Phase 1-3 conversation (already validated,
 * intent-recognized, dated, and vehicle-resolved) plus a `.strict()`
 * selections body — extras/insurance/delivery/discount code identifiers
 * only, never a client-supplied amount (price-manipulation prevention).
 */
export const quoteRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/enquiries/:conversationId/quote',
    {
      schema: {
        tags: ['quote'],
        params: createQuoteParamsSchema,
        body: createQuoteBodySchema,
        response: { 201: createQuoteResponseSchema },
      },
    },
    async (request, reply) => {
      const response = await createQuote(
        {
          prisma: app.ctx.prisma,
          rules: app.ctx.pricingRules,
          integritySecret: app.ctx.config.WEBHOOK_SIGNING_SECRET,
        },
        {
          tenantId: app.ctx.config.DEFAULT_TENANT_ID,
          conversationId: request.params.conversationId,
          requestId: request.id,
          selections: request.body,
        },
      );
      reply.status(201).send(response);
    },
  );

  app.get(
    '/v1/enquiries/:conversationId/quote',
    {
      schema: {
        tags: ['quote'],
        params: getQuoteParamsSchema,
        response: { 200: getQuoteResponseSchema },
      },
    },
    async (request, reply) => {
      const response = await getQuote(
        { prisma: app.ctx.prisma, validator: app.ctx.quoteValidator },
        {
          tenantId: app.ctx.config.DEFAULT_TENANT_ID,
          conversationId: request.params.conversationId,
        },
      );
      reply.status(200).send(response);
    },
  );
};
