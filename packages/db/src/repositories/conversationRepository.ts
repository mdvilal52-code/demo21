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
 * `processedAt: null` in the WHERE clause is what makes this idempotent: a
 * second call for the same conversation matches zero rows (count 0) instead
 * of re-stamping a new timestamp, so callers can use the returned count to
 * decide whether this was the transition that actually happened.
 */
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
 * transcript Steps 1-3 extract against for a multi-turn conversation (see
 * `appendMessageToConversation`), as opposed to `findLatestMessageForConversation`'s
 * single latest row.
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
 * The customer's most recent conversation on this channel, unless it
 * already reached a terminal Step 4 outcome (COMPLETE/EXPIRED/CANCELLED) —
 * in which case there is nothing open to continue and the caller should
 * start a new conversation instead. "Open" is derived from the latest
 * message's latest MissingInfoCheck rather than a new column: same
 * append-only-history convention every other cross-step read in this
 * codebase already uses, so there's no second source of truth to keep in
 * sync.
 *
 * Read outside any transaction, so two genuinely concurrent deliveries for
 * the same customer could both see "nothing open" and each start their own
 * conversation — the same class of race PHASE-5.md §7 already documents and
 * accepts for the idempotency-key pre-check (inherited from Phase 1's
 * submitEnquiry), and no more likely here: real WhatsApp replies from one
 * person are seconds-to-minutes apart, not concurrent.
 */
export async function findOpenConversationForCustomer(
  db: Executor,
  tenantId: TenantId,
  channel: Channel,
  customerRef: string,
): Promise<{ id: string } | null> {
  const conversation = await db.conversation.findFirst({
    where: { tenantId, channel, customerRef },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
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

  const latestStatus = conversation.messages[0]?.missingInfoChecks[0]?.status;
  if (latestStatus === 'COMPLETE' || latestStatus === 'EXPIRED' || latestStatus === 'CANCELLED') {
    return null;
  }

  return { id: conversation.id };
}
