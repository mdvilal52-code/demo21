import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import type { FastifyInstance } from 'fastify';
import type { ApiEnv } from '../env.js';

export async function registerSwagger(app: FastifyInstance, config: ApiEnv): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AI Concierge API',
        description: 'Phase 1 — Enquiry / Intent Recognition',
        version: '0.1.0',
      },
      servers: [{ url: config.API_PUBLIC_URL }],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });
}
