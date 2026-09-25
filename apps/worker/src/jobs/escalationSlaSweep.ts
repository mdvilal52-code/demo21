import {
  findBreachedEscalationCases,
  markEscalationCaseSlaBreached,
  type PrismaClient,
} from '@ai-concierge/db';
import type { Logger } from 'pino';

export interface EscalationSlaSweepOptions {
  prisma: PrismaClient;
  logger: Logger;
  intervalMs: number;
}

/**
 * Housekeeping only — same posture as `startHoldExpirationSweep`. The
 * worker who gets paged when a case is first created (journeyService.ts's
 * `pageTier`, called synchronously at escalation time) is the real,
 * immediate notification; this sweep only flips `slaBreached` for
 * dashboard visibility (the Escalation Queue can sort/highlight overdue
 * cases) and reporting. A plain interval, not a BullMQ job: no retry/
 * at-least-once/persistence guarantees are needed, and a missed tick
 * (e.g. during a deploy) self-heals on the next one, exactly like the hold
 * sweep's own reasoning.
 */
export function startEscalationSlaSweep(options: EscalationSlaSweepOptions): () => void {
  const { prisma, logger, intervalMs } = options;

  const tick = async (): Promise<void> => {
    try {
      const breached = await findBreachedEscalationCases(prisma, new Date());
      for (const escalationCase of breached) {
        await markEscalationCaseSlaBreached(prisma, escalationCase.id);
      }
      if (breached.length > 0) {
        logger.info({ count: breached.length }, 'escalation cases marked SLA-breached');
      }
    } catch (error) {
      logger.error({ err: error }, 'escalation SLA sweep failed; will retry on the next tick');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
