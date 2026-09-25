import {
  Prisma,
  type PrismaClient,
  type EscalationCase as PrismaEscalationCase,
} from '@prisma/client';
import {
  ESCALATION_SLA_MINUTES,
  EscalationStatus,
  escalationCaseSchema,
  type CreateEscalationCaseInput,
  type EscalationCase,
  type EscalationResolutionValue,
  type TenantId,
} from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export function toDomainEscalationCase(row: PrismaEscalationCase): EscalationCase {
  return escalationCaseSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    journeyId: row.journeyId,
    tier: row.tier,
    reason: row.reason,
    status: row.status,
    detail: row.detail,
    assignedToUserId: row.assignedToUserId,
    slaDueAt: row.slaDueAt.toISOString(),
    slaBreached: row.slaBreached,
    resolution: row.resolution,
    resolutionNote: row.resolutionNote,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Caller (journeyService.ts, inside the same transaction as the ESCALATED transition) supplies `now` for testability. */
export async function createEscalationCase(
  tx: Prisma.TransactionClient,
  tenantId: TenantId,
  input: CreateEscalationCaseInput,
  now: Date,
): Promise<EscalationCase> {
  const slaDueAt = new Date(now.getTime() + ESCALATION_SLA_MINUTES[input.tier] * 60_000);
  const row = await tx.escalationCase.create({
    data: {
      tenantId,
      journeyId: input.journeyId,
      tier: input.tier,
      reason: input.reason,
      detail: input.detail,
      slaDueAt,
    },
  });
  return toDomainEscalationCase(row);
}

export async function findEscalationCaseById(
  db: Executor,
  tenantId: TenantId,
  id: string,
): Promise<EscalationCase | null> {
  const row = await db.escalationCase.findFirst({ where: { id, tenantId } });
  return row ? toDomainEscalationCase(row) : null;
}

export async function findOpenEscalationCaseForJourney(
  db: Executor,
  tenantId: TenantId,
  journeyId: string,
): Promise<EscalationCase | null> {
  const row = await db.escalationCase.findFirst({
    where: {
      tenantId,
      journeyId,
      status: { in: [EscalationStatus.OPEN, EscalationStatus.IN_PROGRESS] },
    },
    orderBy: { createdAt: 'desc' },
  });
  return row ? toDomainEscalationCase(row) : null;
}

export interface ListEscalationCasesParams {
  tenantId: TenantId;
  status?: keyof typeof EscalationStatus;
  assignedToUserId?: string | null;
  limit: number;
  offset: number;
}

export async function listEscalationCases(
  db: Executor,
  params: ListEscalationCasesParams,
): Promise<EscalationCase[]> {
  const rows = await db.escalationCase.findMany({
    where: {
      tenantId: params.tenantId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.assignedToUserId !== undefined
        ? { assignedToUserId: params.assignedToUserId }
        : {}),
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    take: params.limit,
    skip: params.offset,
  });
  return rows.map(toDomainEscalationCase);
}

export async function assignEscalationCase(
  db: Executor,
  tenantId: TenantId,
  id: string,
  assignedToUserId: string,
): Promise<EscalationCase | null> {
  const result = await db.escalationCase.updateMany({
    where: { id, tenantId, status: EscalationStatus.OPEN },
    data: { status: EscalationStatus.IN_PROGRESS, assignedToUserId },
  });
  if (result.count === 0) {
    return null;
  }
  return findEscalationCaseById(db, tenantId, id);
}

export interface ResolveEscalationCaseParams {
  tenantId: TenantId;
  id: string;
  resolvedByUserId: string;
  resolution: EscalationResolutionValue;
  resolutionNote: string;
  now: Date;
}

/** Only OPEN/IN_PROGRESS cases can resolve — an already-resolved case is never silently overwritten. */
export async function resolveEscalationCase(
  db: Executor,
  params: ResolveEscalationCaseParams,
): Promise<EscalationCase | null> {
  const result = await db.escalationCase.updateMany({
    where: {
      id: params.id,
      tenantId: params.tenantId,
      status: { in: [EscalationStatus.OPEN, EscalationStatus.IN_PROGRESS] },
    },
    data: {
      status: EscalationStatus.RESOLVED,
      resolution: params.resolution,
      resolutionNote: params.resolutionNote,
      resolvedByUserId: params.resolvedByUserId,
      resolvedAt: params.now,
    },
  });
  if (result.count === 0) {
    return null;
  }
  return findEscalationCaseById(db, params.tenantId, params.id);
}

/** Worker SLA sweep — flips `slaBreached` for reporting/notification-escalation only; never relied on for correctness of the case itself (same "housekeeping, self-heals" posture as `expireDueHolds`). */
export async function findBreachedEscalationCases(
  db: Executor,
  now: Date,
): Promise<EscalationCase[]> {
  const rows = await db.escalationCase.findMany({
    where: {
      status: { in: [EscalationStatus.OPEN, EscalationStatus.IN_PROGRESS] },
      slaBreached: false,
      slaDueAt: { lt: now },
    },
  });
  return rows.map(toDomainEscalationCase);
}

export async function markEscalationCaseSlaBreached(db: Executor, id: string): Promise<void> {
  await db.escalationCase.updateMany({
    where: { id, slaBreached: false },
    data: { slaBreached: true },
  });
}
