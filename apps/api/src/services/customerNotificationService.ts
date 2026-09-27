import {
  NotificationDeliveryStatus,
  NotificationKind,
  findCustomerByIdentity,
  findLatestQuoteForConversation,
  hasNotificationAttempt,
  hasSentNotification,
  recordNotificationDelivery,
  toDomainQuoteSnapshot,
  type Channel,
  type NotificationDeliveryChannelValue,
  type NotificationKindValue,
  type PrismaClient,
} from '@ai-concierge/db';
import type { EmailProvider } from '@ai-concierge/channels';
import {
  QuoteStatus,
  type Customer,
  type QuoteSnapshot,
  type TenantId,
} from '@ai-concierge/domain';
import type { NotificationLimiter } from '../lib/notificationLimiter.js';
import type { NotificationProvider } from '../lib/notificationProvider.js';
import { describeQuote, formatDateTime, formatMoney } from './journeyReplyService.js';
import type { JourneyProgress } from './journeyProgress.js';

/**
 * Automatic email / SMS to the customer as the journey moves: their quote,
 * and the confirmation that a person now has their request. Runs at the end
 * of every inbound turn, so it also covers "the customer gave their email
 * only after the quote" — and a `SENT` record per (kind, quote/journey,
 * channel) guarantees the same notification is never sent twice.
 *
 * Honest by construction: an unconfigured provider is recorded as
 * NOT_CONFIGURED (never a fake success), and nothing here can fail the
 * customer's chat turn — the caller catches everything.
 */
export interface CustomerNotificationDeps {
  prisma: PrismaClient;
  emailProvider: EmailProvider;
  notificationProvider: NotificationProvider;
  limiter: NotificationLimiter;
}

export interface NotifyAfterTurnInput {
  tenantId: TenantId;
  conversationId: string;
  channel: Channel;
  customerRef: string;
  journeyId: string | null;
  progress: JourneyProgress;
  /** For the "quote is still valid" check; injectable for tests. */
  now?: Date;
}

export interface NotifyOutcome {
  kind: NotificationKindValue;
  channel: NotificationDeliveryChannelValue;
  status: 'SENT' | 'FAILED' | 'NOT_CONFIGURED';
}

/** The channel the customer is already talking to us on gets the reply itself — no duplicate there. */
function isSameChannelAsConversation(
  conversationChannel: Channel,
  medium: NotificationDeliveryChannelValue,
  customer: Customer,
  customerRef: string,
): boolean {
  if (medium === 'EMAIL') {
    return conversationChannel === 'EMAIL' && customer.email === customerRef.trim().toLowerCase();
  }
  return (
    conversationChannel === 'WHATSAPP' && customer.phone === `+${customerRef.replace(/\D/g, '')}`
  );
}

function greeting(customer: Customer): string {
  return customer.displayName ? `Hello ${customer.displayName},` : 'Hello,';
}

export function buildQuoteEmail(
  customer: Customer,
  quote: QuoteSnapshot,
  holdExpiresAt: string | null,
): { subject: string; body: string } {
  const total = formatMoney(quote.total.minorUnits, quote.total.currency);
  const hold = holdExpiresAt
    ? ` We are holding the car for you until ${formatDateTime(holdExpiresAt)}.`
    : '';
  return {
    subject: `Your rental quote - ${total}`,
    body: [
      greeting(customer),
      'Thank you for your enquiry. Here is your quote:',
      describeQuote(quote),
      `This quote is valid until ${formatDateTime(quote.validUntil)}.${hold}`,
      'To go ahead, reply "confirm" in the chat and a member of our team will take you through documents and payment. Your eligibility is based on the details you gave us; we verify your passport and licence before handover.',
      'Kind regards,\nYour concierge team',
    ].join('\n\n'),
  };
}

export function buildQuoteSms(quote: QuoteSnapshot): string {
  return (
    `Your rental quote: total ${formatMoney(quote.total.minorUnits, quote.total.currency)} ` +
    `(deposit ${formatMoney(quote.deposit.minorUnits, quote.deposit.currency)}), ` +
    `valid until ${formatDateTime(quote.validUntil)}. Reply in the chat to go ahead.`
  );
}

export function buildHandoffEmail(customer: Customer): { subject: string; body: string } {
  return {
    subject: 'We have your request',
    body: [
      greeting(customer),
      'Thank you. A member of our team now has your rental request and will contact you shortly to complete the documents and payment.',
      'You can keep chatting with our concierge in the meantime and we will see everything you add.',
      'Kind regards,\nYour concierge team',
    ].join('\n\n'),
  };
}

export const HANDOFF_SMS =
  'Thank you - a member of our team has your rental request and will contact you shortly.';

async function deliver(
  deps: CustomerNotificationDeps,
  ctx: {
    tenantId: TenantId;
    conversationId: string;
    kind: NotificationKindValue;
    subjectKey: string;
  },
  medium: NotificationDeliveryChannelValue,
  recipient: string,
  send: () => Promise<{
    status: 'SENT' | 'FAILED' | 'NOT_CONFIGURED';
    ref?: string;
    error?: string;
  }>,
): Promise<NotifyOutcome | null> {
  const key = {
    tenantId: ctx.tenantId,
    kind: ctx.kind,
    subjectKey: ctx.subjectKey,
    channel: medium,
  };
  if (await hasSentNotification(deps.prisma, key)) return null;
  if (!(await deps.limiter.allow(medium, recipient))) {
    if (!(await hasNotificationAttempt(deps.prisma, key))) {
      await recordNotificationDelivery(deps.prisma, {
        ...key,
        conversationId: ctx.conversationId,
        status: NotificationDeliveryStatus.FAILED,
        error: 'RATE_LIMITED',
      });
    }
    return { kind: ctx.kind, channel: medium, status: 'FAILED' };
  }
  const result = await send();
  // An unconfigured provider is recorded once, not on every chat turn.
  if (result.status === 'NOT_CONFIGURED' && (await hasNotificationAttempt(deps.prisma, key))) {
    return { kind: ctx.kind, channel: medium, status: result.status };
  }
  await recordNotificationDelivery(deps.prisma, {
    ...key,
    conversationId: ctx.conversationId,
    status: NotificationDeliveryStatus[result.status],
    providerRef: result.ref ?? null,
    error: result.error ?? null,
  });
  return { kind: ctx.kind, channel: medium, status: result.status };
}

export async function notifyCustomerAfterTurn(
  deps: CustomerNotificationDeps,
  input: NotifyAfterTurnInput,
): Promise<NotifyOutcome[]> {
  const customer = await findCustomerByIdentity(deps.prisma, input.tenantId, {
    channel: input.channel,
    customerRef: input.customerRef,
  });
  if (!customer || (!customer.email && !customer.phone)) return [];

  const outcomes: NotifyOutcome[] = [];
  const base = { tenantId: input.tenantId, conversationId: input.conversationId };
  const email = customer.email;
  const phone = customer.phone;
  const emailAllowed =
    email !== null &&
    !isSameChannelAsConversation(input.channel, 'EMAIL', customer, input.customerRef);
  const smsAllowed =
    phone !== null &&
    !isSameChannelAsConversation(input.channel, 'SMS', customer, input.customerRef);

  const push = (outcome: NotifyOutcome | null): void => {
    if (outcome) outcomes.push(outcome);
  };

  // 1. The current quote, whenever the customer has contact details and it is still valid.
  const quoteRow = await findLatestQuoteForConversation(
    deps.prisma,
    input.tenantId,
    input.conversationId,
  );
  if (quoteRow) {
    const quote = toDomainQuoteSnapshot(quoteRow);
    const stillValid = new Date(quote.validUntil).getTime() > (input.now ?? new Date()).getTime();
    if (quote.status === QuoteStatus.ISSUED && stillValid) {
      const quoteCtx = { ...base, kind: NotificationKind.QUOTE_ISSUED, subjectKey: quote.quoteId };
      const holdExpiresAt =
        input.progress.stage === 'QUOTE_ISSUED' ? input.progress.holdExpiresAt : null;
      if (emailAllowed && email) {
        const mail = buildQuoteEmail(customer, quote, holdExpiresAt);
        push(
          await deliver(deps, quoteCtx, 'EMAIL', email, async () => {
            const result = await deps.emailProvider.sendEmail(email, mail.subject, mail.body);
            return {
              status: result.status,
              ...(result.providerMessageId ? { ref: result.providerMessageId } : {}),
              ...(result.error ? { error: result.error } : {}),
            };
          }),
        );
      }
      if (smsAllowed && phone) {
        push(
          await deliver(deps, quoteCtx, 'SMS', phone, async () => {
            const result = await deps.notificationProvider.sendSms(phone, buildQuoteSms(quote));
            return {
              status: result.status,
              ...(result.providerRef ? { ref: result.providerRef } : {}),
              ...(result.error ? { error: result.error } : {}),
            };
          }),
        );
      }
    }
  }

  // 2. A person now has the request: tell the customer so, once per journey.
  const handedOff =
    (input.progress.stage === 'HUMAN_REVIEW' && input.progress.handoffRecorded) ||
    input.progress.stage === 'ESCALATED_WAITING';
  if (handedOff && input.journeyId) {
    const handoffCtx = {
      ...base,
      kind: NotificationKind.HANDOFF_ACK,
      subjectKey: input.journeyId,
    };
    if (emailAllowed && email) {
      const mail = buildHandoffEmail(customer);
      push(
        await deliver(deps, handoffCtx, 'EMAIL', email, async () => {
          const result = await deps.emailProvider.sendEmail(email, mail.subject, mail.body);
          return {
            status: result.status,
            ...(result.providerMessageId ? { ref: result.providerMessageId } : {}),
            ...(result.error ? { error: result.error } : {}),
          };
        }),
      );
    }
    if (smsAllowed && phone) {
      push(
        await deliver(deps, handoffCtx, 'SMS', phone, async () => {
          const result = await deps.notificationProvider.sendSms(phone, HANDOFF_SMS);
          return {
            status: result.status,
            ...(result.providerRef ? { ref: result.providerRef } : {}),
            ...(result.error ? { error: result.error } : {}),
          };
        }),
      );
    }
  }

  return outcomes;
}
