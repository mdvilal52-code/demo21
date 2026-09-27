import type { Prisma, PrismaClient } from '@prisma/client';
import {
  outboundAttachmentSchema,
  type OutboundAttachment,
  type TenantId,
} from '@ai-concierge/domain';

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
  /** Car photos sent with this reply. */
  attachments?: OutboundAttachment[] | null;
}

export interface StoredOutboundMessage {
  id: string;
  content: string;
  source: string;
  stage: string;
  authorUserId: string | null;
  attachments: OutboundAttachment[];
  createdAt: Date;
}

const outboundSelect = {
  id: true,
  content: true,
  source: true,
  stage: true,
  authorUserId: true,
  attachments: true,
  createdAt: true,
} as const;

interface OutboundRow {
  id: string;
  content: string;
  source: string;
  stage: string;
  authorUserId: string | null;
  attachments: Prisma.JsonValue | null;
  createdAt: Date;
}

/** Re-validates the stored JSON — a malformed column degrades to "no attachments", never a crash. */
function toStored(row: OutboundRow): StoredOutboundMessage {
  const parsed = outboundAttachmentSchema.array().safeParse(row.attachments ?? []);
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    stage: row.stage,
    authorUserId: row.authorUserId,
    attachments: parsed.success ? parsed.data : [],
    createdAt: row.createdAt,
  };
}

export async function createOutboundMessage(
  db: Executor,
  input: CreateOutboundMessageInput,
): Promise<StoredOutboundMessage> {
  const row = await db.outboundMessage.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      content: input.content,
      source: input.source,
      stage: input.stage,
      authorUserId: input.authorUserId ?? null,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments as unknown as Prisma.InputJsonValue }
        : {}),
    },
    select: outboundSelect,
  });
  return toStored(row);
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
    select: outboundSelect,
  });
  return rows.reverse().map(toStored);
}
