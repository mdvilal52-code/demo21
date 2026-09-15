import {
  createEnquiryRequestSchema,
  createEnquiryResponseSchema,
  getConversationResponseSchema,
} from '@ai-concierge/contracts';
import { AppError, intentResultSchema } from '@ai-concierge/domain';
import { findConversationById } from '@ai-concierge/db';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { submitEnquiry } from '../../services/enquiryService.js';

export const enquiryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/enquiries',
    {
      schema: {
        tags: ['enquiries'],
        body: createEnquiryRequestSchema,
        response: { 201: createEnquiryResponseSchema },
        headers: z.object({
          'idempotency-key': z.string().min(1).max(200).optional(),
        }),
      },
    },
    async (request, reply) => {
      const idempotencyKey = request.headers['idempotency-key'];
      const response = await submitEnquiry(
        {
          prisma: app.ctx.prisma,
          intentEngine: app.ctx.intentEngine,
          postEnquiryQueue: app.ctx.postEnquiryQueue,
        },
        {
          tenantId: app.ctx.config.DEFAULT_TENANT_ID,
          channel: request.body.channel,
          customerRef: request.body.customerRef,
          message: request.body.message,
          requestId: request.id,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      );
      reply.status(201).send(response);
    },
  );

  app.get(
    '/v1/enquiries/:conversationId',
    {
      schema: {
        tags: ['enquiries'],
        params: z.object({ conversationId: z.string().uuid() }),
        response: { 200: getConversationResponseSchema },
      },
    },
    async (request, reply) => {
      const conversation = await findConversationById(
        app.ctx.prisma,
        app.ctx.config.DEFAULT_TENANT_ID,
        request.params.conversationId,
      );
      if (!conversation) {
        throw new AppError('NOT_FOUND', 'Conversation not found');
      }

      reply.status(200).send({
        conversationId: conversation.id,
        channel: conversation.channel,
        customerRef: conversation.customerRef,
        createdAt: conversation.createdAt.toISOString(),
        processedAt: conversation.processedAt?.toISOString() ?? null,
        messages: conversation.messages.map((message) => ({
          id: message.id,
          content: message.content,
          createdAt: message.createdAt.toISOString(),
          intents: message.intentRecords.map((record) =>
            intentResultSchema.parse({
              intentType: record.intentType,
              status: record.status,
              confidence: record.confidence,
              entities: record.entities,
              missingFields: record.missingFields,
              ...(record.clarificationPrompt
                ? { clarificationPrompt: record.clarificationPrompt }
                : {}),
              flags: record.flags,
              modelMetadata: record.modelMetadata,
            }),
          ),
        })),
      });
    },
  );
};
