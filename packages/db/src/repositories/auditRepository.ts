import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuditEventInput, AuditWriter } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

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
