import type { Channel, Prisma, PrismaClient } from '@prisma/client';
import type { TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export interface CreateConversationInput {
  tenantId: TenantId;
  channel: Channel;
  customerRef: string;
  content: string;
}

export async function createConversationWithMessage(db: Executor, input: CreateConversationInput) {
  const conversation = await db.conversation.create({
    data: {
      tenantId: input.tenantId,
      channel: input.channel,
      customerRef: input.customerRef,
      messages: { create: { content: input.content } },
    },
    include: { messages: true },
  });
  const message = conversation.messages[0];
  if (!message) {
    throw new Error('Failed to create the initial message for a new conversation');
  }
  return { conversation, message };
}

/**
 * Tenant-scoped read — the WHERE clause always includes tenantId. This is
 * the application-level half of tenant isolation; Row Level Security (the
 * database-level backstop) ships in Phase 2/6.
 */
export async function findConversationById(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
) {
  return db.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { messages: { include: { intentRecords: true } } },
  });
}

/**
 * Step 2 needs "the conversation's latest message" specifically (not just
 * any message via `findConversationById`'s unordered include), scoped to
 * the same tenant-isolation convention via the conversation relation.
 */
export async function findLatestMessageForConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
) {
  return db.message.findFirst({
    where: { conversationId, conversation: { tenantId } },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * `processedAt: null` in the WHERE clause is what makes this idempotent: a
 * second call for the same conversation matches zero rows (count 0) instead
 * of re-stamping a new timestamp, so callers can use the returned count to
 * decide whether this was the transition that actually happened.
 */
export async function markConversationProcessed(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
) {
  return db.conversation.updateMany({
    where: { id: conversationId, tenantId, processedAt: null },
    data: { processedAt: new Date() },
  });
}

/**
 * Every message for a conversation, oldest first — the accumulated
 * transcript Steps 1-3 extract against for a multi-turn conversation, and
 * the short-term memory the conversational reply generator draws its
 * recent-turns slice from.
 */
export async function findMessagesForConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
) {
  return db.message.findMany({
    where: { conversationId, conversation: { tenantId } },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Appends a new message to an existing, tenant-owned conversation — the
 * "continue" counterpart to `createConversationWithMessage`'s "start fresh".
 * Returns null (never throws) when the conversation doesn't exist for this
 * tenant, so the caller decides how to surface that (same convention as
 * `findConversationById`/`findLatestMessageForConversation`).
 */
export async function appendMessageToConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
  content: string,
) {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { id: true },
  });
  if (!conversation) return null;
  return db.message.create({ data: { conversationId, content } });
}

/**
 * How long an untouched conversation stays open. A customer who comes back
 * days later starts fresh rather than resuming a stale quote/hold.
 */
export const CONVERSATION_STALE_AFTER_HOURS = 72;

/**
 * Journey states before Step 5. A conversation whose Step 4 is COMPLETE but
 * whose journey never advanced past these is treated as finished — the same
 * answer as when there is no journey at all — so a journey that failed to
 * sync cannot pin a customer to a completed conversation.
 */
const PRE_ELIGIBILITY_JOURNEY_STATES: ReadonlySet<string> = new Set([
  'ENQUIRY_RECEIVED',
  'EXTRACTING_REQUIREMENTS',
  'VEHICLE_SELECTION',
  'COLLECTING_MISSING_INFO',
]);

/** Journey states in which a conversation is finished — a new message starts a new one. */
const FINISHED_JOURNEY_STATES: ReadonlySet<string> = new Set([
  'CLOSED',
  'CANCELLED',
  'DECLINED',
  'EXPIRED',
]);

/**
 * The customer's most recent conversation on this channel, unless it is
 * finished — in which case there is nothing open to continue and the caller
 * should start a new conversation instead.
 *
 * "Finished" is derived from history that already exists rather than a new
 * column (the append-only convention every other cross-step read here uses):
 *   - Step 4 ended EXPIRED or CANCELLED, or
 *   - Step 4 reached COMPLETE and the conversation has *no* journey, or a
 *     journey that never got past the pre-eligibility states (the
 *     pre-workflow-engine behaviour, kept so old data reads the same), or
 *   - it has a journey that reached a terminal state
 *     (CLOSED/CANCELLED/DECLINED/EXPIRED), or
 *   - nothing has been said in it for CONVERSATION_STALE_AFTER_HOURS.
 * A COMPLETE conversation whose journey is still live (asking for driver
 * details, checking availability, holding a quote, waiting on a human) stays
 * open, so the customer's next reply continues it instead of being read as a
 * brand-new enquiry.
 *
 * Read outside any transaction, so two genuinely concurrent deliveries for
 * the same customer could both see "nothing open" and each start their own
 * conversation — real WhatsApp replies from one person are seconds-to-minutes
 * apart, not concurrent, so this is an accepted, documented race, not an
 * oversight.
 */
export async function findOpenConversationForCustomer(
  db: Executor,
  tenantId: TenantId,
  channel: Channel,
  customerRef: string,
  now: Date = new Date(),
): Promise<{ id: string } | null> {
  const conversation = await db.conversation.findFirst({
    where: { tenantId, channel, customerRef },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      journey: { select: { state: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          createdAt: true,
          missingInfoChecks: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true },
          },
        },
      },
    },
  });
  if (!conversation) return null;

  const latestMessage = conversation.messages[0];
  const latestStatus = latestMessage?.missingInfoChecks[0]?.status;
  if (latestStatus === 'EXPIRED' || latestStatus === 'CANCELLED') return null;

  const journeyState = conversation.journey?.state;
  if (journeyState !== undefined && FINISHED_JOURNEY_STATES.has(journeyState)) return null;
  if (
    latestStatus === 'COMPLETE' &&
    (journeyState === undefined || PRE_ELIGIBILITY_JOURNEY_STATES.has(journeyState))
  ) {
    return null;
  }

  if (latestMessage) {
    const idleMs = now.getTime() - latestMessage.createdAt.getTime();
    if (idleMs > CONVERSATION_STALE_AFTER_HOURS * 60 * 60 * 1000) return null;
  }

  return { id: conversation.id };
}

/** A customer's most recent conversations on one channel, newest first — used to rebuild a web chat's history. */
export async function listRecentConversationsForCustomer(
  db: Executor,
  tenantId: TenantId,
  channel: Channel,
  customerRef: string,
  limit = 5,
): Promise<Array<{ id: string; createdAt: Date }>> {
  return db.conversation.findMany({
    where: { tenantId, channel, customerRef },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, createdAt: true },
  });
}
