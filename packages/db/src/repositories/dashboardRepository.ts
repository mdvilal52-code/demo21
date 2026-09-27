import { Prisma, type PrismaClient } from '@prisma/client';
import type { TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

/** Journey states in which a journey is finished; everything else counts as active. */
const TERMINAL_STATES = new Set(['CLOSED', 'CANCELLED', 'DECLINED', 'EXPIRED']);

export interface DashboardSummaryData {
  journeys: {
    total: number;
    active: number;
    byState: Array<{ state: string; count: number }>;
  };
  escalations: { open: number; inProgress: number; slaBreached: number };
  automation: { journeys: number; escalatedJourneys: number; percentAutomated: number | null };
  quotes: {
    issued: number;
    pendingReview: number;
    quotedValue: Array<{ currency: string; minorUnits: number }>;
  };
  customers: { total: number };
}

interface LatestQuoteRow {
  status: string;
  currency: string;
  minorUnits: bigint | number | null;
}

/**
 * Every figure on the admin Home screen, computed from real rows in one
 * tenant. Quotes are counted once per `quoteId` (its highest `version`), the
 * same "latest row is the current one" rule the quote service uses, so a
 * re-quote never double-counts the value.
 */
export async function getDashboardSummary(
  db: Executor,
  tenantId: TenantId,
): Promise<DashboardSummaryData> {
  const [stateGroups, escalationGroups, breached, escalatedJourneys, latestQuotes, customers] =
    await Promise.all([
      db.journey.groupBy({ by: ['state'], where: { tenantId }, _count: { _all: true } }),
      db.escalationCase.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
      db.escalationCase.count({
        where: { tenantId, slaBreached: true, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      }),
      db.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`SELECT count(DISTINCT "journeyId") AS count FROM "escalation_cases" WHERE "tenantId" = ${tenantId}`,
      ),
      db.$queryRaw<LatestQuoteRow[]>(
        Prisma.sql`SELECT DISTINCT ON ("quoteId") "status"::text AS status, "currency",
                          (("total"->>'minorUnits')::bigint) AS "minorUnits"
                   FROM "quotes" WHERE "tenantId" = ${tenantId}
                   ORDER BY "quoteId", "version" DESC`,
      ),
      db.customer.count({ where: { tenantId } }),
    ]);

  const byState = stateGroups
    .map((group) => ({ state: group.state as string, count: group._count._all }))
    .sort((a, b) => b.count - a.count);
  const totalJourneys = byState.reduce((sum, row) => sum + row.count, 0);
  const activeJourneys = byState
    .filter((row) => !TERMINAL_STATES.has(row.state))
    .reduce((sum, row) => sum + row.count, 0);

  const countFor = (status: string) =>
    escalationGroups.find((group) => group.status === status)?._count._all ?? 0;

  const escalated = Number(escalatedJourneys[0]?.count ?? 0);

  const valueByCurrency = new Map<string, number>();
  let issued = 0;
  let pendingReview = 0;
  for (const row of latestQuotes) {
    if (row.status === 'ISSUED') {
      issued += 1;
      valueByCurrency.set(
        row.currency,
        (valueByCurrency.get(row.currency) ?? 0) + Number(row.minorUnits ?? 0),
      );
    } else if (row.status === 'PENDING_REVIEW') {
      pendingReview += 1;
    }
  }

  return {
    journeys: { total: totalJourneys, active: activeJourneys, byState },
    escalations: {
      open: countFor('OPEN'),
      inProgress: countFor('IN_PROGRESS'),
      slaBreached: breached,
    },
    automation: {
      journeys: totalJourneys,
      escalatedJourneys: escalated,
      percentAutomated:
        totalJourneys === 0
          ? null
          : Math.round(
              ((totalJourneys - Math.min(escalated, totalJourneys)) / totalJourneys) * 1000,
            ) / 10,
    },
    quotes: {
      issued,
      pendingReview,
      quotedValue: [...valueByCurrency.entries()]
        .map(([currency, minorUnits]) => ({ currency, minorUnits }))
        .sort((a, b) => b.minorUnits - a.minorUnits),
    },
    customers: { total: customers },
  };
}

export interface QuoteListRow {
  quoteId: string;
  version: number;
  status: string;
  conversationId: string;
  channel: string;
  customerRef: string;
  vehicleName: string;
  currency: string;
  total: { minorUnits: number; currency: string };
  deposit: { minorUnits: number; currency: string };
  validUntil: Date;
  createdAt: Date;
  requiresHumanReview: boolean;
}

interface RawQuoteListRow {
  quoteId: string;
  version: number;
  status: string;
  conversationId: string;
  channel: string;
  customerRef: string;
  make: string;
  model: string;
  currency: string;
  total: { minorUnits: number; currency: string };
  deposit: { minorUnits: number; currency: string };
  validUntil: Date;
  createdAt: Date;
  requiresHumanReview: boolean;
}

/** One row per quote (its latest version), newest first, with who asked and for which car. */
export async function listLatestQuotes(
  db: Executor,
  params: { tenantId: TenantId; limit: number; offset: number },
): Promise<QuoteListRow[]> {
  const rows = await db.$queryRaw<RawQuoteListRow[]>(
    Prisma.sql`SELECT q."quoteId", q."version", q."status"::text AS status, q."conversationId",
                      c."channel"::text AS channel, c."customerRef", v."make", v."model",
                      q."currency", q."total", q."deposit", q."validUntil", q."createdAt",
                      q."requiresHumanReview"
               FROM (
                 SELECT DISTINCT ON ("quoteId") *
                 FROM "quotes" WHERE "tenantId" = ${params.tenantId}
                 ORDER BY "quoteId", "version" DESC
               ) q
               JOIN "conversations" c ON c."id" = q."conversationId" AND c."tenantId" = ${params.tenantId}
               JOIN "vehicles" v ON v."id" = q."vehicleId" AND v."tenantId" = ${params.tenantId}
               ORDER BY q."createdAt" DESC
               LIMIT ${params.limit} OFFSET ${params.offset}`,
  );
  return rows.map((row) => ({
    quoteId: row.quoteId,
    version: row.version,
    status: row.status,
    conversationId: row.conversationId,
    channel: row.channel,
    customerRef: row.customerRef,
    vehicleName: `${row.make} ${row.model}`,
    currency: row.currency,
    total: row.total,
    deposit: row.deposit,
    validUntil: row.validUntil,
    createdAt: row.createdAt,
    requiresHumanReview: row.requiresHumanReview,
  }));
}

/** The newest eligibility decision made for any message of a conversation. */
export async function findLatestEligibilityDecisionForConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
) {
  return db.eligibilityDecision.findFirst({
    where: { tenantId, message: { conversationId } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { status: true, reason: true, createdAt: true },
  });
}

/** What Steps 2-4 last resolved for a conversation (vehicle, dates, location), read back from the newest Step 4 row. */
export async function findLatestCollectedBookingInfo(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
): Promise<unknown | null> {
  const row = await db.missingInfoCheck.findFirst({
    where: { tenantId, message: { conversationId } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { collected: true },
  });
  return row?.collected ?? null;
}
