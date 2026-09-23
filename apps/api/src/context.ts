import type {
  DateLocationExtractionOrchestrator,
  EligibilityOrchestrator,
  FleetProvider,
  IntentEngine,
  MissingInfoOrchestrator,
  VehicleDeterminationOrchestrator,
} from '@ai-concierge/ai';
import type { WhatsAppProvider } from '@ai-concierge/channels';
import type { PrismaClient } from '@ai-concierge/db';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ApiEnv } from './env.js';
import type { ReservationLockService } from './services/reservationLockService.js';

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
  eligibilityOrchestrator: EligibilityOrchestrator;
  whatsappProvider: WhatsAppProvider;
  /** Exposed for future admin-Settings visibility (matches `whatsappProvider`'s role) — consumed directly by `reservationLockService`, not read elsewhere yet. */
  fleetProvider: FleetProvider;
  reservationLockService: ReservationLockService;
  observabilityStatus: 'CONFIGURED' | 'NOT_CONFIGURED';
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
