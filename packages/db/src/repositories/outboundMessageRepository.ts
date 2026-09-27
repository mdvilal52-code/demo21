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

export interface CreateOutboundMessageInput {
  tenantId: TenantId;
  conversationId: string;
  content: string;
  source: OutboundMessageSourceValue;
  /** The journey stage the reply was written for. */
  stage: string;
  /** The staff user who wrote a HUMAN reply. */
  authorUserId?: string | null;
}

export interface StoredOutboundMessage {
  id: string;
  content: string;
  source: string;
  stage: string;
  authorUserId: string | null;
  createdAt: Date;
}

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
    },
    select: {
      id: true,
      content: true,
      source: true,
      stage: true,
      authorUserId: true,
      createdAt: true,
    },
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
    select: {
      id: true,
      content: true,
      source: true,
      stage: true,
      authorUserId: true,
      createdAt: true,
    },
  });
  return rows.reverse();
}
