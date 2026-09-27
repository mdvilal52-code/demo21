import type { Prisma, PrismaClient } from '@prisma/client';
import type { TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export const OutboundMessageSource = {
  AI_GENERATED: 'AI_GENERATED',
  TEMPLATE: 'TEMPLATE',
  HUMAN: 'HUMAN',
} as const;
export type OutboundMessageSourceValue =
  (typeof OutboundMessageSource)[keyof typeof OutboundMessageSource];

export const OutboundMessageStatus = {
  SENT: 'SENT',
  FAILED: 'FAILED',
} as const;
export type OutboundMessageStatusValue =
  (typeof OutboundMessageStatus)[keyof typeof OutboundMessageStatus];

/** How long a claim (`claimFailedOutboundMessageForResend`) is honoured before it is considered stale and reclaimable — a crashed attempt must not block this row forever. */
export const RESEND_CLAIM_STALE_MS = 60_000;

export interface CreateOutboundMessageInput {
  tenantId: TenantId;
  conversationId: string;
  content: string;
  source: OutboundMessageSourceValue;
  /** The journey stage the reply was written for. */
  stage: string;
  /** The staff user who wrote a HUMAN reply. */
  authorUserId?: string | null;
  /** Defaults to SENT — the long-standing behaviour for every call site that only ever recorded a successful send. */
  status?: OutboundMessageStatusValue;
  deliveryError?: string | null;
  /** The email subject actually used — only ever set for the EMAIL channel, so a resend can reuse it instead of a generic fallback. */
  subject?: string | null;
}

export interface StoredOutboundMessage {
  id: string;
  content: string;
  source: string;
  stage: string;
  authorUserId: string | null;
  status: string;
  deliveryError: string | null;
  retryCount: number;
  subject: string | null;
  createdAt: Date;
}

const STORED_MESSAGE_SELECT = {
  id: true,
  content: true,
  source: true,
  stage: true,
  authorUserId: true,
  status: true,
  deliveryError: true,
  retryCount: true,
  subject: true,
  createdAt: true,
} as const;

export async function createOutboundMessage(
  db: Executor,
  input: CreateOutboundMessageInput,
): Promise<StoredOutboundMessage> {
  return db.outboundMessage.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      content: input.content,
      source: input.source,
      stage: input.stage,
      authorUserId: input.authorUserId ?? null,
      status: input.status ?? OutboundMessageStatus.SENT,
      deliveryError: input.deliveryError ?? null,
      subject: input.subject ?? null,
    },
    select: STORED_MESSAGE_SELECT,
  });
}

/** Oldest-first, tenant-scoped; `limit` keeps the most recent rows. */
export async function findOutboundMessagesForConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
  limit = 50,
): Promise<StoredOutboundMessage[]> {
  const rows = await db.outboundMessage.findMany({
    where: { tenantId, conversationId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: STORED_MESSAGE_SELECT,
  });
  return rows.reverse();
}

/**
 * Scoped by `conversationId` as well as `tenantId`, not just the message's
 * own id: a staff-triggered resend takes both as separate URL params, and
 * without this the two could be mismatched — sending one conversation's
 * (private) failed content to a *different* conversation's customer while
 * marking the wrong row delivered.
 */
export async function findOutboundMessageById(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
  id: string,
): Promise<StoredOutboundMessage | null> {
  return db.outboundMessage.findFirst({
    where: { tenantId, conversationId, id },
    select: STORED_MESSAGE_SELECT,
  });
}

/**
 * FAILED rows tenant-wide, past `retryNotBefore` (never hammer a provider
 * outage immediately), under `maxRetryCount` (give up eventually rather
 * than retry forever), and not currently claimed by another in-flight
 * resend attempt — what the worker's resend sweep acts on. Oldest first: a
 * customer who has been waiting longest gets retried first.
 */
export async function findResendableEmailMessages(
  db: Executor,
  input: { retryNotBefore: Date; maxRetryCount: number; limit: number },
): Promise<Array<StoredOutboundMessage & { tenantId: string; customerRef: string }>> {
  const rows = await db.outboundMessage.findMany({
    where: {
      status: OutboundMessageStatus.FAILED,
      retryCount: { lt: input.maxRetryCount },
      createdAt: { lte: input.retryNotBefore },
      conversation: { channel: 'EMAIL' },
      OR: [
        { claimedAt: null },
        { claimedAt: { lt: new Date(Date.now() - RESEND_CLAIM_STALE_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: input.limit,
    select: {
      ...STORED_MESSAGE_SELECT,
      tenantId: true,
      conversation: { select: { customerRef: true } },
    },
  });
  return rows.map(({ conversation, ...row }) => ({ ...row, customerRef: conversation.customerRef }));
}

/**
 * Atomically claims one FAILED row for an in-flight resend attempt, so the
 * automatic sweep and a staff-triggered resend can never both act on the
 * same row at once: the conditional `updateMany` only matches (and so only
 * one concurrent caller only ever affects a row) while `status` is still
 * FAILED and no *unstale* claim already exists. Returns whether *this*
 * caller won the claim. Always release it afterwards via
 * `recordOutboundMessageResendOutcome`, win or lose — a crashed attempt
 * still self-heals once `RESEND_CLAIM_STALE_MS` passes.
 */
export async function claimFailedOutboundMessageForResend(
  db: Executor,
  tenantId: TenantId,
  id: string,
): Promise<boolean> {
  const result = await db.outboundMessage.updateMany({
    where: {
      tenantId,
      id,
      status: OutboundMessageStatus.FAILED,
      OR: [
        { claimedAt: null },
        { claimedAt: { lt: new Date(Date.now() - RESEND_CLAIM_STALE_MS) } },
      ],
    },
    data: { claimedAt: new Date() },
  });
  return result.count === 1;
}

/** Records the outcome of a resend attempt and releases its claim: SENT clears the error, a further failure bumps retryCount. */
export async function recordOutboundMessageResendOutcome(
  db: Executor,
  id: string,
  outcome: { status: OutboundMessageStatusValue; deliveryError: string | null },
): Promise<void> {
  await db.outboundMessage.update({
    where: { id },
    data:
      outcome.status === OutboundMessageStatus.SENT
        ? { status: OutboundMessageStatus.SENT, deliveryError: null, claimedAt: null }
        : { deliveryError: outcome.deliveryError, retryCount: { increment: 1 }, claimedAt: null },
  });
}

/**
 * Releases a claim without recording an attempt (no retryCount bump, no
 * status/error change) — for when the claimed send was never actually
 * tried (e.g. the provider reports NOT_CONFIGURED), so this row stays
 * exactly as retryable as it was before the claim.
 */
export async function releaseOutboundMessageResendClaim(db: Executor, id: string): Promise<void> {
  await db.outboundMessage.update({ where: { id }, data: { claimedAt: null } });
}
