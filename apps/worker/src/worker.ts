import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { createPrismaClient } from '@ai-concierge/db';
import { postEnquiryJobSchema, QUEUE_NAMES } from '@ai-concierge/contracts';
import {
  bootstrapObservability,
  checkRedisEvictionPolicy,
  createLogger,
} from '@ai-concierge/observability';
import { loadWorkerEnv } from './env.js';
import { startHoldExpirationSweep } from './jobs/holdExpirationSweep.js';
import { processPostEnquiryJob } from './processors/postEnquiryProcessor.js';

async function main(): Promise<void> {
  const config = loadWorkerEnv();

  const observability = bootstrapObservability({
    serviceName: config.OTEL_SERVICE_NAME,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
  });

  const logger = createLogger({
    level: config.LOG_LEVEL,
    serviceName: 'worker',
    pretty: config.NODE_ENV === 'development',
  });

  const prisma = createPrismaClient(config.DATABASE_URL);
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  await checkRedisEvictionPolicy(connection, logger);

  const worker = new Worker(
    QUEUE_NAMES.POST_ENQUIRY_PROCESSING,
    async (job: Job) => {
      const data = postEnquiryJobSchema.parse(job.data);
      await processPostEnquiryJob({ prisma, logger }, data);
    },
    { connection, concurrency: config.WORKER_CONCURRENCY },
  );

  worker.on('completed', (job) => logger.info({ jobId: job.id }, 'job completed'));
  worker.on('failed', (job, error) => logger.error({ jobId: job?.id, err: error }, 'job failed'));

  const stopHoldExpirationSweep = startHoldExpirationSweep({
    prisma,
    logger,
    intervalMs: config.HOLD_EXPIRATION_SWEEP_INTERVAL_MS,
  });

  logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    stopHoldExpirationSweep();
    await worker.close();
    await Promise.allSettled([prisma.$disconnect(), connection.quit(), observability.shutdown()]);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('Fatal error during worker startup', error);
  process.exit(1);
});
