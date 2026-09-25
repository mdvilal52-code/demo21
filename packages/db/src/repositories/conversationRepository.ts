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
 * The customer's most recent conversation on this channel, regardless of
 * whether it's still open — callers decide reopenability (see
 * `enquiryService.submitEnquiry`) by inspecting its latest message/status
 * themselves. Tenant-scoped like every other read here.
 */
export async function findMostRecentConversationForCustomer(
  db: Executor,
  tenantId: TenantId,
  channel: Channel,
  customerRef: string,
) {
  return db.conversation.findFirst({
    where: { tenantId, channel, customerRef },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Appends a message to an existing conversation instead of starting a new
 * one — the reopen path in `submitEnquiry`. Tenant isolation is enforced by
 * scoping the update to `id + tenantId`: a mismatched tenant matches zero
 * rows and this throws, the same failure shape as a not-found conversation.
 */
export async function appendMessageToConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
  content: string,
) {
  const conversation = await db.conversation.update({
    where: { id: conversationId, tenantId },
    data: { messages: { create: { content } } },
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  const message = conversation.messages[0];
  if (!message) {
    throw new Error('Failed to append message to conversation');
  }
  return { conversation, message };
}

/**
 * Full turn history for the transcript fed to Steps 2-3 (see
 * `buildConversationTranscript`) and to the conversational reply service's
 * short-term memory — oldest first, capped so one runaway conversation can't
 * unboundedly grow extractor input or a future model prompt.
 */
export async function findMessagesForConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
  options: { limit?: number } = {},
) {
  const messages = await db.message.findMany({
    where: { conversationId, conversation: { tenantId } },
    orderBy: { createdAt: 'desc' },
    take: options.limit ?? 20,
  });
  return messages.reverse();
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
