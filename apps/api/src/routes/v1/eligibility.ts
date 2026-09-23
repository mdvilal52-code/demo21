import {
  checkEligibilityBodySchema,
  checkEligibilityParamsSchema,
  checkEligibilityResponseSchema,
} from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { checkEligibility } from '../../services/eligibilityService.js';

/**
 * Step 5 — Eligibility. Customer/driver data is new at this step (never
 * collected by Steps 1-4), so it is the request body, Zod-validated
 * (`.strict()` — no unrecognized key, including an attempt to smuggle in a
 * `status`/`policyId`, ever reaches the service). Vehicle/dates/location
 * are read from the conversation, exactly like Step 4's endpoint.
 */
export const eligibilityRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/enquiries/:conversationId/eligibility',
    {
      schema: {
        tags: ['eligibility'],
        params: checkEligibilityParamsSchema,
        body: checkEligibilityBodySchema,
        response: { 201: checkEligibilityResponseSchema },
      },
    },
    async (request, reply) => {
      const response = await checkEligibility(
        { prisma: app.ctx.prisma, orchestrator: app.ctx.eligibilityOrchestrator },
        {
          tenantId: app.ctx.config.DEFAULT_TENANT_ID,
          conversationId: request.params.conversationId,
          requestId: request.id,
          body: request.body,
        },
      );
      reply.status(201).send(response);
    },
  );
};
