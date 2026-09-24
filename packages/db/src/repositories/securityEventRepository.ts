import type { Prisma, PrismaClient } from '@prisma/client';
import type { SecurityEventTypeValue, SecuritySeverityValue } from '@ai-concierge/domain';
import type { TenantScopedClient } from '../tenantContext.js';

type Executor = PrismaClient | Prisma.TransactionClient | TenantScopedClient;

export interface RecordSecurityEventInput {
  tenantId: string;
  userId?: string;
  type: SecurityEventTypeValue;
  severity: SecuritySeverityValue;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/** The detection & response layer's write path — append-only, same convention as AuditEvent. */
export async function recordSecurityEvent(db: Executor, input: RecordSecurityEventInput) {
  await db.securityEvent.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      type: input.type,
      severity: input.severity,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: (input.metadata as Prisma.InputJsonValue) ?? {},
    },
  });
}

export interface ListSecurityEventsInput {
  tenantId: string;
  severity?: SecuritySeverityValue;
  limit: number;
  cursor?: string;
}

/** Newest-first, keyset-paginated by id (createdAt ties are broken by id, avoiding the skip/duplicate issues offset pagination has under concurrent writes). */
export async function listSecurityEvents(db: Executor, input: ListSecurityEventsInput) {
  return db.securityEvent.findMany({
    where: {
      tenantId: input.tenantId,
      ...(input.severity ? { severity: input.severity } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
}

/** Anomaly rule input: how many of `type` this tenant has recorded since `since`. */
export async function countRecentSecurityEvents(
  db: Executor,
  tenantId: string,
  type: SecurityEventTypeValue,
  since: Date,
) {
  return db.securityEvent.count({
    where: { tenantId, type, createdAt: { gte: since } },
  });
}
