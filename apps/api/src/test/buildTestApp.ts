import {
  DateLocationExtractionOrchestrator,
  EligibilityOrchestrator,
  MissingInfoOrchestrator,
  RuleBasedIntentEngine,
  VehicleDeterminationOrchestrator,
} from '@ai-concierge/ai';
import { NotConfiguredWhatsAppProvider, type WhatsAppProvider } from '@ai-concierge/channels';
import {
  createTestPrismaClient,
  createTestRedisClient,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import { createLogger } from '@ai-concierge/observability';
import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import { buildApp } from '../app.js';
import type { AppContext } from '../context.js';
import type { ApiEnv } from '../env.js';
import { PrismaVehicleCatalogProvider } from '../services/vehicleCatalogProvider.js';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  close: () => Promise<void>;
}

export interface TestAppCtxOverrides {
  whatsappProvider?: WhatsAppProvider;
}

export async function buildTestApp(
  overrides: Partial<ApiEnv> = {},
  ctxOverrides: TestAppCtxOverrides = {},
): Promise<TestApp> {
  const config: ApiEnv = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    REDIS_URL: process.env.REDIS_URL ?? '',
    OUTBOUND_ALLOWED_HOSTS: ['localhost', '127.0.0.1'],
    WEBHOOK_SIGNING_SECRET: 'test-secret-value-1234567890',
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
    OTEL_SERVICE_NAME: 'api-test',
    DEFAULT_TENANT_ID: TEST_TENANT_ID,
    API_PORT: 0,
    API_HOST: '127.0.0.1',
    API_PUBLIC_URL: 'http://localhost:4000',
    CORS_ALLOWED_ORIGINS: ['http://localhost:3000'],
    API_BODY_LIMIT_BYTES: 102_400,
    // High by default so ordinary integration tests never trip the limiter,
    // which (per @fastify/rate-limit) tracks one counter per IP for the
    // whole app/test file. Tests that specifically exercise rate limiting
    // override this with their own low value on a dedicated app instance.
    RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_WINDOW_MS: 60_000,
    WHATSAPP_API_VERSION: 'v21.0',
    ...overrides,
  };

  const prisma = createTestPrismaClient();
  const redis = createTestRedisClient();
  const postEnquiryQueue = new Queue('post-enquiry-processing-test', {
    connection: redis.duplicate(),
  });

  const ctx: AppContext = {
    config,
    logger: createLogger({ level: 'silent', serviceName: 'api-test' }),
    prisma,
    redis,
    postEnquiryQueue,
    intentEngine: new RuleBasedIntentEngine(),
    dateLocationOrchestrator: new DateLocationExtractionOrchestrator(),
    vehicleOrchestrator: new VehicleDeterminationOrchestrator({
      catalogProvider: new PrismaVehicleCatalogProvider(prisma),
    }),
    missingInfoOrchestrator: new MissingInfoOrchestrator(),
    eligibilityOrchestrator: new EligibilityOrchestrator(),
    whatsappProvider: ctxOverrides.whatsappProvider ?? new NotConfiguredWhatsAppProvider(),
    observabilityStatus: 'NOT_CONFIGURED',
  };

  const app = await buildApp(ctx, ctx.logger);
  await app.ready();

  return {
    app,
    ctx,
    close: async () => {
      await app.close();
      await postEnquiryQueue.close();
      await prisma.$disconnect();
      await redis.quit();
    },
  };
}
