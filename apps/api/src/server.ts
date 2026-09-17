import {
  DateLocationExtractionOrchestrator,
  MissingInfoOrchestrator,
  RuleBasedIntentEngine,
  VehicleDeterminationOrchestrator,
} from '@ai-concierge/ai';
import { createPrismaClient } from '@ai-concierge/db';
import { createLogger, bootstrapObservability } from '@ai-concierge/observability';
import { buildApp } from './app.js';
import type { AppContext } from './context.js';
import { loadApiEnv } from './env.js';
import { createPostEnquiryQueue } from './lib/queue.js';
import { createRedisClient } from './lib/redis.js';
import { PrismaVehicleCatalogProvider } from './services/vehicleCatalogProvider.js';

async function main(): Promise<void> {
  const config = loadApiEnv();

  const observability = bootstrapObservability({
    serviceName: config.OTEL_SERVICE_NAME,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
  });

  const logger = createLogger({
    level: config.LOG_LEVEL,
    serviceName: 'api',
    pretty: config.NODE_ENV === 'development',
  });

  const prisma = createPrismaClient(config.DATABASE_URL);
  const redis = createRedisClient(config.REDIS_URL);
  const postEnquiryQueue = createPostEnquiryQueue(redis.duplicate());
  const intentEngine = new RuleBasedIntentEngine();
  const dateLocationOrchestrator = new DateLocationExtractionOrchestrator();
  const vehicleOrchestrator = new VehicleDeterminationOrchestrator({
    catalogProvider: new PrismaVehicleCatalogProvider(prisma),
  });
  const missingInfoOrchestrator = new MissingInfoOrchestrator();

  const ctx: AppContext = {
    config,
    logger,
    prisma,
    redis,
    postEnquiryQueue,
    intentEngine,
    dateLocationOrchestrator,
    vehicleOrchestrator,
    missingInfoOrchestrator,
    observabilityStatus: observability.status,
  };

  const app = await buildApp(ctx, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await Promise.allSettled([
      prisma.$disconnect(),
      redis.quit(),
      postEnquiryQueue.close(),
      observability.shutdown(),
    ]);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}

main().catch((error: unknown) => {
  console.error('Fatal error during API startup', error);
  process.exit(1);
});
