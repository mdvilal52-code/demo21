import { DEFAULT_REPLY_SUBJECT, type EmailProvider } from '@ai-concierge/channels';
import {
  claimFailedOutboundMessageForResend,
  findConversationById,
  findOutboundMessageById,
  recordOutboundMessageResendOutcome,
  releaseOutboundMessageResendClaim,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, type TenantId } from '@ai-concierge/domain';

export interface EmailResendDeps {
  prisma: PrismaClient;
  emailProvider: EmailProvider;
}

export interface ResendEmailInput {
  tenantId: TenantId;
  conversationId: string;
  outboundMessageId: string;
  userId: string;
  requestId: string;
}

export interface ResendEmailResult {
  delivered: boolean;
  status: 'SENT' | 'FAILED' | 'NOT_CONFIGURED';
}

/**
 * Staff-triggered counterpart to the automatic resend sweep
 * (`emailResendSweep.ts`) — same underlying re-attempt, just on demand for
 * one message instead of periodically for every eligible one. Re-sends the
 * exact content (and subject) that was already computed; it never
 * regenerates or edits it, so this can never become a second way to put
 * new words in the customer's mouth.
 */
export async function resendFailedEmailMessage(
  deps: EmailResendDeps,
  input: ResendEmailInput,
): Promise<ResendEmailResult> {
  const conversation = await findConversationById(deps.prisma, input.tenantId, input.conversationId);
  if (!conversation) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }
  if (conversation.channel !== 'EMAIL') {
    throw new AppError('CONFLICT', 'Only an email reply can be resent');
  }

  // Scoped by conversationId as well as id: the message must genuinely
  // belong to *this* conversation, never just any message the caller can
  // guess the id of — see findOutboundMessageById's own doc comment.
  const message = await findOutboundMessageById(
    deps.prisma,
    input.tenantId,
    input.conversationId,
    input.outboundMessageId,
  );
  if (!message) {
    throw new AppError('NOT_FOUND', 'Message not found');
  }
  if (message.status !== 'FAILED') {
    throw new AppError('CONFLICT', 'This message was already delivered');
  }

  const claimed = await claimFailedOutboundMessageForResend(deps.prisma, input.tenantId, message.id);
  if (!claimed) {
    // The automatic sweep (or another staff member) is already retrying
    // this exact message right now — never send it twice.
    throw new AppError('CONFLICT', 'This message is already being resent — try again shortly');
  }

  const result = await deps.emailProvider.sendEmail(
    conversation.customerRef,
    message.subject ?? DEFAULT_REPLY_SUBJECT,
    message.content,
  );
  const delivered = result.status === 'SENT';
  if (result.status === 'NOT_CONFIGURED') {
    // Nothing was actually attempted — release the claim without touching
    // status/retryCount/error, so this row stays exactly as retryable.
    await releaseOutboundMessageResendClaim(deps.prisma, message.id);
  } else {
    await recordOutboundMessageResendOutcome(deps.prisma, message.id, {
      status: delivered ? 'SENT' : 'FAILED',
      deliveryError: result.error ?? null,
    });
  }

  await new PrismaAuditWriter(deps.prisma).record({
    tenantId: input.tenantId,
    actor: `user:${input.userId}`,
    action: 'conversation.email_resend',
    entityType: 'Conversation',
    entityId: input.conversationId,
    after: { outboundMessageId: message.id, delivered, status: result.status },
    requestId: input.requestId,
  });

  return { delivered, status: result.status };
}
