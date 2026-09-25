import {
  Prisma,
  type PrismaClient,
  type Journey as PrismaJourney,
  type JourneyTransition as PrismaJourneyTransition,
} from '@prisma/client';
import {
  journeyContextSchema,
  journeySchema,
  journeyTransitionSchema,
  type Journey,
  type JourneyContext,
  type JourneyStateValue,
  type JourneyActorValue,
  type JourneyTransition,
  type TenantId,
} from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export function toDomainJourney(row: PrismaJourney): Journey {
  return journeySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    conversationId: row.conversationId,
    state: row.state,
    context: journeyContextSchema.parse(row.context),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function toDomainJourneyTransition(row: PrismaJourneyTransition): JourneyTransition {
  return journeyTransitionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    journeyId: row.journeyId,
    fromState: row.fromState,
    toState: row.toState,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Serializes every read-then-transition for one conversation's journey,
 * exactly like `acquireVehicleLock`/`acquireConversationQuoteLock` do for
 * their own resource — held for the rest of the enclosing transaction,
 * released automatically on commit/rollback. `version` (below) is kept as
 * a second, defense-in-depth layer, the same dual-layer safety Step 8's
 * quote lock already established.
 */
export async function acquireJourneyLock(
  tx: Prisma.TransactionClient,
  tenantId: TenantId,
  conversationId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId} || ':journey:' || ${conversationId})::bigint)`;
}

export async function findJourneyByConversationId(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
): Promise<Journey | null> {
  const row = await db.journey.findFirst({ where: { tenantId, conversationId } });
  return row ? toDomainJourney(row) : null;
}

export async function findJourneyById(
  db: Executor,
  tenantId: TenantId,
  journeyId: string,
): Promise<Journey | null> {
  const row = await db.journey.findFirst({ where: { id: journeyId, tenantId } });
  return row ? toDomainJourney(row) : null;
}

export interface ListJourneysParams {
  tenantId: TenantId;
  state?: JourneyStateValue;
  limit: number;
  offset: number;
}

/** The admin dashboard's Journeys screen list — most-recently-updated first, so an ops agent sees active conversations at the top. */
export async function listJourneys(db: Executor, params: ListJourneysParams): Promise<Journey[]> {
  const rows = await db.journey.findMany({
    where: { tenantId: params.tenantId, ...(params.state ? { state: params.state } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: params.limit,
    skip: params.offset,
  });
  return rows.map(toDomainJourney);
}

export interface CreateJourneyParams {
  tenantId: TenantId;
  conversationId: string;
  context: JourneyContext;
}

/** Caller must already hold `acquireJourneyLock` in this same transaction. */
export async function createJourney(
  tx: Prisma.TransactionClient,
  params: CreateJourneyParams,
): Promise<Journey> {
  const row = await tx.journey.create({
    data: {
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      context: params.context,
    },
  });
  await tx.journeyTransition.create({
    data: {
      tenantId: params.tenantId,
      journeyId: row.id,
      fromState: null,
      toState: row.state,
      actor: 'SYSTEM',
      reason: 'Journey created',
    },
  });
  return toDomainJourney(row);
}

export interface TransitionJourneyParams {
  tenantId: TenantId;
  journeyId: string;
  expectedVersion: number;
  toState: JourneyStateValue;
  context: JourneyContext;
  actor: JourneyActorValue;
  reason: string;
}

export type TransitionJourneyResult =
  { outcome: 'TRANSITIONED'; journey: Journey } | { outcome: 'VERSION_CONFLICT' };

/**
 * Caller must already hold `acquireJourneyLock` in this same transaction and
 * must have already checked `checkTransition` (@ai-concierge/workflow) —
 * this function trusts its `toState` and only enforces the optimistic
 * version match, the same "persistence layer never re-derives a decision
 * a domain/orchestrator layer already made" split every other repository
 * in this codebase keeps (e.g. `createEligibilityDecision` never
 * re-evaluates eligibility).
 */
export async function transitionJourney(
  tx: Prisma.TransactionClient,
  params: TransitionJourneyParams,
): Promise<TransitionJourneyResult> {
  const current = await tx.journey.findFirst({
    where: { id: params.journeyId, tenantId: params.tenantId },
  });
  if (!current || current.version !== params.expectedVersion) {
    return { outcome: 'VERSION_CONFLICT' };
  }

  const updated = await tx.journey.update({
    where: { id: params.journeyId },
    data: {
      state: params.toState,
      context: params.context,
      version: { increment: 1 },
    },
  });
  await tx.journeyTransition.create({
    data: {
      tenantId: params.tenantId,
      journeyId: params.journeyId,
      fromState: current.state,
      toState: params.toState,
      actor: params.actor,
      reason: params.reason,
    },
  });
  return { outcome: 'TRANSITIONED', journey: toDomainJourney(updated) };
}

export async function findJourneyTransitions(
  db: Executor,
  tenantId: TenantId,
  journeyId: string,
): Promise<JourneyTransition[]> {
  const rows = await db.journeyTransition.findMany({
    where: { tenantId, journeyId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toDomainJourneyTransition);
}
