import type {
  DateLocationExtractionOrchestrator,
  IntentEngine,
  MissingInfoOrchestrator,
  VehicleDeterminationOrchestrator,
} from '@ai-concierge/ai';
import type { PrismaClient } from '@ai-concierge/db';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ApiEnv } from './env.js';

export interface AppContext {
  config: ApiEnv;
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
  postEnquiryQueue: Queue;
  intentEngine: IntentEngine;
  dateLocationOrchestrator: DateLocationExtractionOrchestrator;
  vehicleOrchestrator: VehicleDeterminationOrchestrator;
  missingInfoOrchestrator: MissingInfoOrchestrator;
  observabilityStatus: 'CONFIGURED' | 'NOT_CONFIGURED';
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
