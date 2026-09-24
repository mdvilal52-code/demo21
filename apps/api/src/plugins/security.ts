import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { buildCorsOriginChecker, buildSecureHeadersPolicy } from '@ai-concierge/security';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { ApiEnv } from '../env.js';
import { rejectKnownScannerUserAgents } from '../lib/waf.js';

export async function registerSecurityPlugins(
  app: FastifyInstance,
  config: ApiEnv,
  redis: Redis,
): Promise<void> {
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

  // Redis-backed so the limit is shared across every API instance, not
  // per-process — MASTER-PLAN.md §6 Phase 6 "Edge: Redis-backed rate
  // limiting". Per-route overrides (e.g. /v1/auth/login's stricter
  // AUTH_RATE_LIMIT_MAX) layer on top via each route's own `config.rateLimit`.
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    redis,
  });

  app.addHook('onRequest', rejectKnownScannerUserAgents);

  await app.register(sensible);
}
