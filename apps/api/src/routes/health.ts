import {
  healthResponseSchema,
  livenessResponseSchema,
  readinessResponseSchema,
} from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

const startedAt = Date.now();

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    { schema: { response: { 200: healthResponseSchema }, tags: ['health'] } },
    async () => ({
      status: 'ok' as const,
      service: app.ctx.config.OTEL_SERVICE_NAME,
      version: '0.1.0',
      observability: app.ctx.observabilityStatus,
    }),
  );

  app.get(
    '/live',
    { schema: { response: { 200: livenessResponseSchema }, tags: ['health'] } },
    async () => ({
      status: 'alive' as const,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );

  app.get(
    '/ready',
    {
      schema: {
        response: { 200: readinessResponseSchema, 503: readinessResponseSchema },
        tags: ['health'],
      },
    },
    async (_request, reply) => {
      const [databaseUp, redisUp] = await Promise.all([
        app.ctx.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
        app.ctx.redis
          .ping()
          .then(() => true)
          .catch(() => false),
      ]);

      const body = {
        status: databaseUp && redisUp ? ('ready' as const) : ('not_ready' as const),
        dependencies: {
          database: databaseUp ? ('up' as const) : ('down' as const),
          redis: redisUp ? ('up' as const) : ('down' as const),
        },
      };

      reply.status(body.status === 'ready' ? 200 : 503).send(body);
    },
  );
};
