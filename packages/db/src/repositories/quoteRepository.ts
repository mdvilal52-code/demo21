import { Prisma, type PrismaClient, type Quote as PrismaQuote } from '@prisma/client';
import { quoteSnapshotSchema, type QuoteSnapshot, type TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

/**
 * Maps a Prisma row back to the domain `QuoteSnapshot` shape and
 * re-validates via Zod — the same "never trust it just because it's our own
 * DB" posture `toDomainVehicle` already applies, doubly relevant here since
 * `QuoteValidator.verifyIntegrity` is what actually proves this row hasn't
 * been altered outside the application (a Zod shape mismatch and a hash
 * mismatch are different failure modes — this function only guards the
 * former).
 */
export function toDomainQuoteSnapshot(row: PrismaQuote): QuoteSnapshot {
  return quoteSnapshotSchema.parse({
    quoteId: row.quoteId,
    version: row.version,
    status: row.status,
    currency: row.currency,
    lineItems: row.lineItems,
    taxes: row.taxes,
    fees: row.fees,
    discounts: row.discounts,
    deposit: row.deposit,
    total: row.total,
    validUntil: row.validUntil.toISOString(),
    pricingVersion: row.pricingVersion,
    requiresHumanReview: row.requiresHumanReview,
    reviewReasons: row.reviewReasons,
    integrityHash: row.integrityHash,
    modelMetadata: row.modelMetadata,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Step 8 — same `pg_advisory_xact_lock` pattern Phase 6's
 * `acquireVehicleLock` established: every concurrent quote request for the
 * *same conversation* serializes here, so two concurrent "no quote yet"
 * reads can never both mint a fresh `quoteId`, and two concurrent re-quotes
 * can never both write `version + 1` — see `QuoteService.getOrCreateQuote`
 * for the in-lock re-check that relies on this. Namespaced with a literal
 * `:quote:` segment so its hash space never collides with
 * `acquireVehicleLock`'s for a coincidentally-equal `tenantId`/id pair.
 */
export async function acquireConversationQuoteLock(
  tx: Prisma.TransactionClient,
  tenantId: TenantId,
  conversationId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId} || ':quote:' || ${conversationId})::bigint)`;
}

export interface CreateQuoteInput {
  tenantId: TenantId;
  conversationId: string;
  messageId: string;
  vehicleId: string;
  snapshot: QuoteSnapshot;
}

/** Caller must already hold `acquireConversationQuoteLock` in this same transaction. Append-only — never an update. */
export async function createQuote(db: Executor, input: CreateQuoteInput) {
  const { snapshot } = input;
  return db.quote.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      vehicleId: input.vehicleId,
      quoteId: snapshot.quoteId,
      version: snapshot.version,
      status: snapshot.status,
      currency: snapshot.currency,
      lineItems: snapshot.lineItems as unknown as Prisma.InputJsonValue,
      taxes: snapshot.taxes as unknown as Prisma.InputJsonValue,
      fees: snapshot.fees as unknown as Prisma.InputJsonValue,
      discounts: snapshot.discounts as unknown as Prisma.InputJsonValue,
      deposit: snapshot.deposit as unknown as Prisma.InputJsonValue,
      total: snapshot.total as unknown as Prisma.InputJsonValue,
      validUntil: new Date(snapshot.validUntil),
      pricingVersion: snapshot.pricingVersion,
      requiresHumanReview: snapshot.requiresHumanReview,
      reviewReasons: snapshot.reviewReasons as unknown as Prisma.InputJsonValue,
      integrityHash: snapshot.integrityHash,
      modelMetadata: snapshot.modelMetadata,
    },
  });
}

/** Tenant-scoped read of the highest-version row for this conversation — the "current" quote. */
export async function findLatestQuoteForConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
) {
  return db.quote.findFirst({
    where: { tenantId, conversationId },
    orderBy: [{ version: 'desc' }],
  });
}
