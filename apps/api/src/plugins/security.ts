import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { buildCorsOriginChecker, buildSecureHeadersPolicy } from '@ai-concierge/security';
import type { FastifyInstance } from 'fastify';
import type { ApiEnv } from '../env.js';

export async function registerSecurityPlugins(app: FastifyInstance, config: ApiEnv): Promise<void> {
  const policy = buildSecureHeadersPolicy();

  await app.register(helmet, {
    contentSecurityPolicy: policy.contentSecurityPolicy,
    referrerPolicy: { policy: policy.referrerPolicy as 'no-referrer' },
    crossOriginResourcePolicy: { policy: policy.crossOriginResourcePolicy },
    hsts: { maxAge: policy.hstsMaxAgeSeconds, includeSubDomains: true },
  });

  const originChecker = buildCorsOriginChecker(config.CORS_ALLOWED_ORIGINS);
  await app.register(cors, {
    origin: (origin, callback) => {
      originChecker(origin, (err, allow) => callback(err, allow ?? false));
    },
    credentials: false,
    methods: ['GET', 'POST'],
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
  });

  await app.register(sensible);
}
