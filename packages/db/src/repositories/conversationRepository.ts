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
