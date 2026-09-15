import { markConversationProcessed, PrismaAuditWriter, type PrismaClient } from '@ai-concierge/db';
import type { PostEnquiryJob } from '@ai-concierge/contracts';
import type { Logger } from 'pino';

export interface PostEnquiryProcessorDeps {
  prisma: PrismaClient;
  logger: Logger;
}

/**
 * Marks the conversation processed and records an audit event. Idempotent:
 * running the same job twice (BullMQ retries, at-least-once delivery) is
 * safe — `markConversationProcessed` only flips rows that aren't already
 * flipped, and a zero-count result short-circuits without a duplicate audit
 * entry.
 */
export async function processPostEnquiryJob(
  deps: PostEnquiryProcessorDeps,
  job: PostEnquiryJob,
): Promise<void> {
  const result = await markConversationProcessed(deps.prisma, job.tenantId, job.conversationId);

  if (result.count === 0) {
    deps.logger.warn(
      { tenantId: job.tenantId, conversationId: job.conversationId },
      'post-enquiry job found nothing to process (already processed or unknown conversation)',
    );
    return;
  }

  const auditWriter = new PrismaAuditWriter(deps.prisma);
  await auditWriter.record({
    tenantId: job.tenantId,
    actor: 'worker:post-enquiry-processing',
    action: 'conversation.processed',
    entityType: 'Conversation',
    entityId: job.conversationId,
    requestId: job.requestId,
  });
}
