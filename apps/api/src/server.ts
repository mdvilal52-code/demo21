import {
  DateLocationExtractionOrchestrator,
  MissingInfoOrchestrator,
  RuleBasedIntentEngine,
  VehicleDeterminationOrchestrator,
} from '@ai-concierge/ai';
import { createPrismaClient } from '@ai-concierge/db';
import {
  createLogger,
  bootstrapObservability,
  checkRedisEvictionPolicy,
} from '@ai-concierge/observability';
import { buildApp } from './app.js';
import type { AppContext } from './context.js';
import { loadApiEnv } from './env.js';
import { createAIProvider } from './lib/geminiProvider.js';
import { createPostEnquiryQueue } from './lib/queue.js';
import { createRedisClient } from './lib/redis.js';
import { createWhatsAppClient } from './lib/whatsappClient.js';
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
  await checkRedisEvictionPolicy(redis, logger);
  const postEnquiryQueue = createPostEnquiryQueue(redis.duplicate());
  const intentEngine = new RuleBasedIntentEngine();
  const dateLocationOrchestrator = new DateLocationExtractionOrchestrator();
  const vehicleOrchestrator = new VehicleDeterminationOrchestrator({
    catalogProvider: new PrismaVehicleCatalogProvider(prisma),
  });
  const missingInfoOrchestrator = new MissingInfoOrchestrator();
  const { client: whatsappClient, status: whatsappStatus } = createWhatsAppClient(config);
  const { provider: aiProvider, status: aiProviderStatus } = createAIProvider(config);

  if (aiProviderStatus === 'CONFIGURED') {
    // Catches a bad GEMINI_MODEL_ID (or an unreachable API) at deploy time
    // instead of discovering it silently later, one degraded-to-fallback
    // reply at a time — see docs/phases/PHASE-06.md §7.
    const health = await aiProvider.healthCheck();
    if (health === 'CONFIGURED') {
      logger.info({ modelId: config.GEMINI_MODEL_ID }, 'Gemini provider reachable');
    } else {
      logger.error(
        { modelId: config.GEMINI_MODEL_ID, health },
        'GEMINI_API_KEY is set but the configured model is not reachable — conversational replies will fall back to deterministic templates until this is fixed',
      );
    }
  }

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
    whatsappClient,
    whatsappStatus,
    aiProvider,
    aiProviderStatus,
  };
  logger.info({ whatsappStatus, aiProviderStatus }, 'WhatsApp adapter / AI provider status');

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
