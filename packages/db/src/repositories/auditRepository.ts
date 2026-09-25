import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuditEventInput, AuditWriter } from '@ai-concierge/domain';
import type { TenantScopedClient } from '../tenantContext.js';

type Executor = PrismaClient | Prisma.TransactionClient | TenantScopedClient;

export class PrismaAuditWriter implements AuditWriter {
  constructor(private readonly db: Executor) {}

  async record(event: AuditEventInput): Promise<void> {
    await this.db.auditEvent.create({
      data: {
        tenantId: event.tenantId,
        actor: event.actor,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        before: (event.before as Prisma.InputJsonValue) ?? undefined,
        after: (event.after as Prisma.InputJsonValue) ?? undefined,
        requestId: event.requestId ?? null,
        ip: event.ip ?? null,
      },
    });
  }
}

export interface ListAuditEventsInput {
  tenantId: string;
  limit: number;
  cursor?: string;
}

/** Newest-first, keyset-paginated — Phase 7's Audit log screen's read path (MASTER-PLAN.md §5.7), first exposed here behind AuthZ (`GET /v1/audit-events`). */
export async function listAuditEvents(db: Executor, input: ListAuditEventsInput) {
  return db.auditEvent.findMany({
    where: { tenantId: input.tenantId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
}
