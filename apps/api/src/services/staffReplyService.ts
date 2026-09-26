import type { EmailProvider, WhatsAppProvider } from '@ai-concierge/channels';
import type { StaffReplyResponse } from '@ai-concierge/contracts';
import {
  createOutboundMessage,
  findConversationById,
  findJourneyByConversationId,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, TERMINAL_JOURNEY_STATES, type TenantId } from '@ai-concierge/domain';
import { flagUnexpectedPiiInOutboundText } from '../lib/dlp.js';

export interface StaffReplyDeps {
  prisma: PrismaClient;
  whatsappProvider: WhatsAppProvider;
  emailProvider: EmailProvider;
  logger: Parameters<typeof flagUnexpectedPiiInOutboundText>[0]['logger'];
}

export interface StaffReplyInput {
  tenantId: TenantId;
  userId: string;
  conversationId: string;
  message: string;
  requestId: string;
}

const EMAIL_SUBJECT = 'Re: Your rental enquiry';

/**
 * Human worker: a staff member answers the customer directly. The message goes
 * out over the customer's own channel — WhatsApp or Email through the same
 * provider the concierge uses, or into the customer's web chat — and is
 * recorded as an outbound message with `source = HUMAN` and the staff user
 * as author, so the whole thread (concierge and person) reads as one
 * conversation and every human word is attributable.
 *
 * Nothing is recorded, and `delivered` is `false`, when the channel could not
 * actually deliver it (provider NOT_CONFIGURED, or a send failure): the
 * dashboard then tells the staff member plainly that the customer did not
 * receive it, instead of showing a reply the customer never saw.
 */
export async function sendStaffReply(
  deps: StaffReplyDeps,
  input: StaffReplyInput,
): Promise<StaffReplyResponse> {
  const conversation = await findConversationById(
    deps.prisma,
    input.tenantId,
    input.conversationId,
  );
  if (!conversation) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }
  const journey = await findJourneyByConversationId(
    deps.prisma,
    input.tenantId,
    input.conversationId,
  );
  if (journey && TERMINAL_JOURNEY_STATES.includes(journey.state)) {
    throw new AppError('CONFLICT', 'This conversation has already ended', {
      details: { journeyState: journey.state },
    });
  }

  await flagUnexpectedPiiInOutboundText(
    { prisma: deps.prisma, logger: deps.logger },
    { tenantId: input.tenantId, channel: conversation.channel, text: input.message },
  );

  let delivery: StaffReplyResponse['delivery'];
  if (conversation.channel === 'WEB') {
    // The customer's chat polls the same conversation, so storing it *is* delivering it.
    delivery = 'STORED';
  } else if (conversation.channel === 'WHATSAPP') {
    delivery = (
      await deps.whatsappProvider.sendTextMessage(conversation.customerRef, input.message)
    ).status;
  } else {
    delivery = (
      await deps.emailProvider.sendEmail(conversation.customerRef, EMAIL_SUBJECT, input.message)
    ).status;
  }

  const delivered = delivery === 'SENT' || delivery === 'STORED';
  let stored: StaffReplyResponse['message'] = null;
  if (delivered) {
    const row = await createOutboundMessage(deps.prisma, {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      content: input.message,
      source: 'HUMAN',
      stage: 'STAFF_REPLY',
      authorUserId: input.userId,
    });
    stored = {
      id: row.id,
      role: 'STAFF',
      content: row.content,
      source: row.source,
      stage: row.stage,
      authorUserId: row.authorUserId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // The audit trail records that a person replied and whether it reached the
  // customer — never the message text itself.
  await new PrismaAuditWriter(deps.prisma).record({
    tenantId: input.tenantId,
    actor: `user:${input.userId}`,
    action: 'conversation.staff_reply',
    entityType: 'Conversation',
    entityId: input.conversationId,
    after: { channel: conversation.channel, delivery, length: input.message.length },
    requestId: input.requestId,
  });

  return { delivered, delivery, message: stored };
}
