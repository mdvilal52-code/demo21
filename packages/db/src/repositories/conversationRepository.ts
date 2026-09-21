import type { Channel, ConversationStage, Prisma, PrismaClient } from '@prisma/client';
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
 * Finds the customer's most recently started conversation on this channel,
 * regardless of stage — the WhatsApp channel adapter uses this to resume an
 * ongoing thread instead of starting a new, context-free one for every
 * inbound message (see `whatsappConversationState.ts`). Tenant-scoped, same
 * isolation convention as every other repository read.
 */
export async function findLatestConversationForCustomer(
  db: Executor,
  tenantId: TenantId,
  channel: Channel,
  customerRef: string,
) {
  return db.conversation.findFirst({
    where: { tenantId, channel, customerRef },
    // `id` (a UUID, not sortable, but stable) only matters as a
    // deterministic tiebreaker when two rows share a `createdAt` — it never
    // overrides `createdAt` ordering itself.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

export interface AppendMessageToConversationInput {
  tenantId: TenantId;
  conversationId: string;
  content: string;
}

/**
 * Adds a new message to an already-existing conversation, tenant-scoped —
 * the append counterpart to `createConversationWithMessage`'s create path.
 * Returns null (never throws) when the conversation doesn't belong to this
 * tenant, so callers can decide how to handle that the same way a `findFirst`
 * miss is normally handled.
 */
export async function appendMessageToConversation(
  db: Executor,
  input: AppendMessageToConversationInput,
) {
  const conversation = await db.conversation.findFirst({
    where: { id: input.conversationId, tenantId: input.tenantId },
  });
  if (!conversation) return null;

  const message = await db.message.create({
    data: { conversationId: input.conversationId, content: input.content },
  });
  return { conversation, message };
}

/**
 * Persists the WhatsApp stage machine's next stage — tenant-scoped, same
 * `updateMany` + WHERE-tenantId convention as `markConversationProcessed`.
 * `cycleStartedAt`, when given, marks the start of a new booking cycle (a
 * COMPLETE -> NEW reset for a repeat customer's next, unrelated request) so
 * the next message's cross-message merge (`whatsappConversationState.ts`)
 * stops looking at the finished cycle's now-irrelevant dates/vehicle.
 */
export async function updateConversationStage(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
  stage: ConversationStage,
  cycleStartedAt?: Date,
) {
  return db.conversation.updateMany({
    where: { id: conversationId, tenantId },
    data: { stage, ...(cycleStartedAt ? { cycleStartedAt } : {}) },
  });
}
