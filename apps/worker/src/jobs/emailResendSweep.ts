import { DEFAULT_REPLY_SUBJECT, type EmailProvider } from '@ai-concierge/channels';
import {
  claimFailedOutboundMessageForResend,
  findResendableEmailMessages,
  recordOutboundMessageResendOutcome,
  releaseOutboundMessageResendClaim,
} from '@ai-concierge/db';
import type { PrismaClient } from '@ai-concierge/db';
import type { Logger } from 'pino';

export interface EmailResendSweepOptions {
  prisma: PrismaClient;
  emailProvider: EmailProvider;
  logger: Logger;
  intervalMs: number;
  minAgeMs: number;
  maxAttempts: number;
}

const SWEEP_BATCH_SIZE = 25;

/**
 * Automatic half of "email retry/resend" (the other half is the
 * staff-triggered `POST .../resend` route, `emailResendService.ts`): most
 * Mailgun API failures are transient (a momentary network blip, a rate
 * limit), so a customer should not need a staff member to notice and click
 * resend for those to recover. Same housekeeping posture as the hold/SLA
 * sweeps — a plain interval, not a BullMQ job, because a missed tick just
 * means the next one catches up, and correctness never depends on this
 * running (a FAILED row is not lost if the sweep is briefly down).
 *
 * Each row is claimed (`claimFailedOutboundMessageForResend`) before this
 * sweep touches it, so it can never race a staff member clicking "resend"
 * on the same message at the same time — see that function's own doc
 * comment for why an atomic claim is required here.
 */
export function startEmailResendSweep(options: EmailResendSweepOptions): () => void {
  const { prisma, emailProvider, logger, intervalMs, minAgeMs, maxAttempts } = options;

  const tick = async (): Promise<void> => {
    try {
      const due = await findResendableEmailMessages(prisma, {
        retryNotBefore: new Date(Date.now() - minAgeMs),
        maxRetryCount: maxAttempts,
        limit: SWEEP_BATCH_SIZE,
      });
      let attempted = 0;
      let resent = 0;
      for (const message of due) {
        const claimed = await claimFailedOutboundMessageForResend(prisma, message.tenantId, message.id);
        if (!claimed) continue; // a staff member is resending this one right now

        const result = await emailProvider.sendEmail(
          message.customerRef,
          message.subject ?? DEFAULT_REPLY_SUBJECT,
          message.content,
        );
        if (result.status === 'NOT_CONFIGURED') {
          // Nothing to attempt for the rest of this batch either — release
          // and stop instead of claiming/releasing every remaining row for
          // no reason.
          await releaseOutboundMessageResendClaim(prisma, message.id);
          break;
        }
        attempted += 1;
        await recordOutboundMessageResendOutcome(prisma, message.id, {
          status: result.status === 'SENT' ? 'SENT' : 'FAILED',
          deliveryError: result.error ?? null,
        });
        if (result.status === 'SENT') resent += 1;
      }
      if (attempted > 0) {
        logger.info({ attempted, resent }, 'email resend sweep: retried failed outbound emails');
      }
    } catch (error) {
      logger.error({ err: error }, 'email resend sweep failed; will retry on the next tick');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
