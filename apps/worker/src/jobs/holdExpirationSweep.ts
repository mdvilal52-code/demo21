import { expireDueHolds, type PrismaClient } from '@ai-concierge/db';
import type { Logger } from 'pino';

export interface HoldExpirationSweepOptions {
  prisma: PrismaClient;
  logger: Logger;
  intervalMs: number;
}

/**
 * Housekeeping only — never relied on for correctness. Every read that
 * matters (`availabilityHoldRepository.countOverlappingHolds`) already
 * treats a past-`expiresAt` ACTIVE hold as expired on its own, so this sweep
 * exists purely to flip the row's persisted status for reporting/dashboards
 * and to stop the row count growing unbounded with dead ACTIVE rows. A
 * plain interval (not a BullMQ job) is a deliberate choice: this task needs
 * no retry/at-least-once/persistence guarantees — a periodic idempotent bulk
 * UPDATE achieves the same outcome with less machinery, and a missed tick
 * (e.g. during a deploy) self-heals on the next one.
 */
export function startHoldExpirationSweep(options: HoldExpirationSweepOptions): () => void {
  const { prisma, logger, intervalMs } = options;

  const tick = async (): Promise<void> => {
    try {
      const count = await expireDueHolds(prisma, new Date());
      if (count > 0) {
        logger.info({ count }, 'expired availability holds past their TTL');
      }
    } catch (error) {
      logger.error({ err: error }, 'hold expiration sweep failed; will retry on the next tick');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
