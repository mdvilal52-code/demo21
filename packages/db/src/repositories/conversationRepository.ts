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

/**
 * Appends a follow-up customer message to an existing conversation — the
 * minimal capability Step 4's multi-turn loop needs to receive a reply at
 * all (no generic channel-adapter message ingestion exists yet; that's
 * Phase 5's WhatsApp/Web-chat/Email scope). Returns null when the
 * conversation doesn't exist for this tenant, the same tenant-scoped
 * "null means not found" convention `findLatestMessageForConversation` uses.
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
 * Step 4 needs both the conversation's channel (drives whether contact
 * details are necessary) and its latest message (the turn to process) in
 * one read — a conversation always has at least one message from creation,
 * so a null `message` here would indicate corrupted data, never a normal
 * "not found" case (that's `conversation` being null).
 */
export async function findConversationWithLatestMessage(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
) {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!conversation) return null;

  const [message] = conversation.messages;
  if (!message) return null;

  return { channel: conversation.channel, message };
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
