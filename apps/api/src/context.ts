import type {
  AIProvider,
  AlternativeRecommendationOrchestrator,
  DateLocationExtractionOrchestrator,
  EligibilityOrchestrator,
  FleetProvider,
  IntentEngine,
  MissingInfoOrchestrator,
  PricingRules,
  QuoteValidator,
  VehicleDeterminationOrchestrator,
} from '@ai-concierge/ai';
import type { EmailProvider, WhatsAppProvider } from '@ai-concierge/channels';
import type { PrismaClient } from '@ai-concierge/db';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ApiEnv } from './env.js';
import type { NotificationProvider } from './lib/notificationProvider.js';
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
  alternativeRecommendationOrchestrator: AlternativeRecommendationOrchestrator;
  pricingRules: PricingRules;
  quoteValidator: QuoteValidator;
  whatsappProvider: WhatsAppProvider;
  whatsappProviderStatus: 'CONFIGURED' | 'NOT_CONFIGURED';
  emailProvider: EmailProvider;
  emailProviderStatus: 'CONFIGURED' | 'NOT_CONFIGURED';
  notificationProvider: NotificationProvider;
  notificationProviderStatus: 'CONFIGURED' | 'NOT_CONFIGURED';
  /** Exposed for future admin-Settings visibility (matches `whatsappProvider`'s role) — consumed directly by `reservationLockService`, not read elsewhere yet. */
  fleetProvider: FleetProvider;
  reservationLockService: ReservationLockService;
  observabilityStatus: 'CONFIGURED' | 'NOT_CONFIGURED';
  aiProvider: AIProvider;
  aiProviderStatus: 'CONFIGURED' | 'NOT_CONFIGURED';
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
