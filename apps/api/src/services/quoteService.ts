import { randomUUID } from 'node:crypto';
import {
  AvailabilityRequestError,
  calculatePricing,
  canonicalJSONStringify,
  computeRentalDurationDays,
  detectPricingAnomalies,
  signQuoteSnapshot,
  validateAvailabilityRequest,
  verifyQuoteIntegrity,
  type PricingRules,
  type QuoteValidator,
} from '@ai-concierge/ai';
import {
  acquireConversationQuoteLock,
  createQuote as createQuoteRow,
  findConversationById,
  findLatestDateLocationExtractionForMessage,
  findLatestMessageForConversation,
  findLatestQuoteForConversation,
  findLatestVehicleDeterminationForMessage,
  toDomainQuoteSnapshot,
  toDomainVehicle,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import {
  AppError,
  QuoteErrorCode,
  QuoteStatus,
  quoteSnapshotSchema,
  type QuoteSelections,
  type QuoteSnapshot,
  type TenantId,
} from '@ai-concierge/domain';
import type { CreateQuoteResponse } from '@ai-concierge/contracts';

export interface QuoteServiceDeps {
  prisma: PrismaClient;
  rules: PricingRules;
  /** Reused from `config.WEBHOOK_SIGNING_SECRET` — see quoteValidator.ts's own doc for why. */
  integritySecret: string;
}

export interface CreateQuoteInput {
  tenantId: TenantId;
  conversationId: string;
  requestId: string;
  selections: QuoteSelections;
}

const MODEL_METADATA = { engine: 'quote-service', version: '1.0.0', deterministic: true } as const;

/** The fields that make two quotes "the same" for duplicate-detection — every price-bearing fact, nothing version/timing-specific. */
function pricingIdentity(
  snapshot: Pick<
    QuoteSnapshot,
    'currency' | 'lineItems' | 'taxes' | 'fees' | 'discounts' | 'deposit' | 'total'
  >,
): string {
  return canonicalJSONStringify({
    currency: snapshot.currency,
    lineItems: snapshot.lineItems,
    taxes: snapshot.taxes,
    fees: snapshot.fees,
    discounts: snapshot.discounts,
    deposit: snapshot.deposit,
    total: snapshot.total,
  });
}

/**
 * Step 8 — Quote (MASTER-PLAN.md journey Step 8, `QUOTE_ISSUED`). Input is a
 * conversation's already-resolved Step 3 vehicle + Step 2 dates (never raw
 * text) plus a Zod-`.strict()` selections body (never a raw amount — "AI
 * must NEVER invent prices" / price-manipulation prevention) — same
 * convention as Steps 2-7 for the read side, extended with a real request
 * body for the one genuinely new input this step needs.
 *
 * Concurrency-safe versioning: `acquireConversationQuoteLock` serializes
 * every quote request for this conversation, and the "is there already a
 * latest version, and does it still apply" decision happens *inside* that
 * lock, after re-reading — the same "re-check inside the lock, don't trust a
 * pre-lock read" discipline Phase 6's own tests found necessary for
 * `ReservationLockService.placeHold`.
 */
export async function createQuote(
  deps: QuoteServiceDeps,
  input: CreateQuoteInput,
): Promise<CreateQuoteResponse> {
  const [conversation, message] = await Promise.all([
    findConversationById(deps.prisma, input.tenantId, input.conversationId),
    findLatestMessageForConversation(deps.prisma, input.tenantId, input.conversationId),
  ]);
  if (!conversation || !message) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }

  const [vehicleRow, dateLocationRow] = await Promise.all([
    findLatestVehicleDeterminationForMessage(deps.prisma, input.tenantId, message.id),
    findLatestDateLocationExtractionForMessage(deps.prisma, input.tenantId, message.id),
  ]);

  if (!vehicleRow || vehicleRow.status !== 'RESOLVED' || !vehicleRow.resolvedVehicle) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Vehicle has not been resolved yet for this conversation',
      { details: { code: QuoteErrorCode.VEHICLE_NOT_RESOLVED } },
    );
  }
  if (!dateLocationRow?.pickupDate || !dateLocationRow.returnDate) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Pickup/return dates have not been resolved yet for this conversation',
      { details: { code: QuoteErrorCode.DATES_NOT_RESOLVED } },
    );
  }

  // Step 2's dates were valid when resolved, but time can pass before a
  // quote is requested (same class of staleness Step 6's own orchestrator
  // re-checks on every run, for the same reason) — never price a rental
  // whose date range no longer makes sense.
  try {
    validateAvailabilityRequest(dateLocationRow.pickupDate, dateLocationRow.returnDate, new Date());
  } catch (error) {
    if (error instanceof AvailabilityRequestError) {
      const code =
        error.code === 'PICKUP_DATE_NOW_IN_PAST'
          ? QuoteErrorCode.PICKUP_DATE_NOW_IN_PAST
          : QuoteErrorCode.RETURN_BEFORE_OR_EQUAL_PICKUP;
      throw new AppError('VALIDATION_FAILED', error.message, { details: { code } });
    }
    throw error;
  }

  const requestedVehicle = toDomainVehicle(vehicleRow.resolvedVehicle);
  const durationDays = computeRentalDurationDays(
    dateLocationRow.pickupDate,
    dateLocationRow.returnDate,
  );

  // Pure computation — no DB read of concurrently-changing state, so this is
  // safe to run before the lock (unlike Step 6's availability check).
  const pricing = calculatePricing({
    vehicle: requestedVehicle,
    durationDays,
    selections: input.selections,
    rules: deps.rules,
  });
  const anomalies = detectPricingAnomalies(pricing, deps.rules);

  const now = new Date();
  const validUntil = new Date(now.getTime() + deps.rules.validityHours * 60 * 60 * 1000);

  const result = await deps.prisma.$transaction(async (tx) => {
    await acquireConversationQuoteLock(tx, input.tenantId, input.conversationId);

    const existingRow = await findLatestQuoteForConversation(
      tx,
      input.tenantId,
      input.conversationId,
    );
    let existing: QuoteSnapshot | null = null;
    if (existingRow) {
      const candidate = toDomainQuoteSnapshot(existingRow);
      // A tampered row can never be trusted for a duplicate-reuse decision,
      // nor extended as this lineage's next version — audit it and proceed
      // as if no trustworthy quote exists yet for this conversation.
      if (verifyQuoteIntegrity(candidate, deps.integritySecret)) {
        existing = candidate;
      } else {
        const auditWriter = new PrismaAuditWriter(tx);
        await auditWriter.record({
          tenantId: input.tenantId,
          actor: 'system:quote',
          action: 'quote.tamper_detected',
          entityType: 'Quote',
          entityId: existingRow.id,
          after: { quoteId: existingRow.quoteId, version: existingRow.version },
          requestId: input.requestId,
        });
      }
    }

    // "Duplicate quote": an existing, unexpired, untampered quote with
    // identical priced content is returned as-is — never a wasteful new
    // version for terms that haven't changed.
    if (existing && new Date(existing.validUntil).getTime() > now.getTime()) {
      if (pricingIdentity(existing) === pricingIdentity(toJSONFields(pricing))) {
        return existing;
      }
    }

    const quoteId = existing ? existing.quoteId : randomUUID();
    const version = existing ? existing.version + 1 : 1;

    const withoutHash = {
      quoteId,
      version,
      status: anomalies.requiresHumanReview ? QuoteStatus.PENDING_REVIEW : QuoteStatus.ISSUED,
      ...toJSONFields(pricing),
      validUntil: validUntil.toISOString(),
      pricingVersion: deps.rules.version,
      requiresHumanReview: anomalies.requiresHumanReview,
      reviewReasons: anomalies.reviewReasons,
      modelMetadata: MODEL_METADATA,
      createdAt: now.toISOString(),
    };
    const integrityHash = signQuoteSnapshot(withoutHash, deps.integritySecret);
    const snapshot = quoteSnapshotSchema.parse({ ...withoutHash, integrityHash });

    await createQuoteRow(tx, {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: message.id,
      vehicleId: requestedVehicle.id,
      snapshot,
    });

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: input.tenantId,
      actor: 'system:quote',
      action: 'quote.issued',
      entityType: 'Message',
      entityId: message.id,
      after: {
        quoteId: snapshot.quoteId,
        version: snapshot.version,
        status: snapshot.status,
        total: snapshot.total,
        requiresHumanReview: snapshot.requiresHumanReview,
      },
      requestId: input.requestId,
    });

    return snapshot;
  });

  return {
    conversationId: input.conversationId,
    messageId: message.id,
    quote: result,
  };
}

export interface GetQuoteInput {
  tenantId: TenantId;
  conversationId: string;
}

export interface GetQuoteDeps {
  prisma: PrismaClient;
  validator: QuoteValidator;
}

/**
 * Read-only: the current (latest-version) quote for a conversation, or a
 * clear `QUOTE_EXPIRED`/`QUOTE_TAMPERED` failure instead of silently
 * returning stale or corrupted data — the one live caller of
 * `QuoteValidator.validate`.
 */
export async function getQuote(
  deps: GetQuoteDeps,
  input: GetQuoteInput,
): Promise<CreateQuoteResponse> {
  const conversation = await findConversationById(
    deps.prisma,
    input.tenantId,
    input.conversationId,
  );
  if (!conversation) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }

  const row = await findLatestQuoteForConversation(
    deps.prisma,
    input.tenantId,
    input.conversationId,
  );
  if (!row) {
    throw new AppError('NOT_FOUND', 'No quote has been generated yet for this conversation', {
      details: { code: QuoteErrorCode.QUOTE_NOT_FOUND },
    });
  }

  const snapshot = toDomainQuoteSnapshot(row);
  deps.validator.validate(snapshot);

  return { conversationId: input.conversationId, messageId: row.messageId, quote: snapshot };
}

/** `PricingCalculationResult`'s `Money`/enum fields, converted to their JSON (schema) shape. */
function toJSONFields(pricing: ReturnType<typeof calculatePricing>) {
  return {
    currency: pricing.currency,
    lineItems: pricing.lineItems.map((item) => ({
      category: item.category,
      code: item.code,
      description: item.description,
      quantity: item.quantity,
      unitAmount: item.unitAmount.toJSON(),
      amount: item.amount.toJSON(),
    })),
    taxes: pricing.taxes.map((tax) => ({
      code: tax.code,
      description: tax.description,
      ratePercent: tax.ratePercent,
      amount: tax.amount.toJSON(),
    })),
    fees: pricing.fees.map((fee) => ({
      code: fee.code,
      description: fee.description,
      amount: fee.amount.toJSON(),
    })),
    discounts: pricing.discounts.map((discount) => ({
      code: discount.code,
      description: discount.description,
      amount: discount.amount.toJSON(),
    })),
    deposit: pricing.deposit.toJSON(),
    total: pricing.total.toJSON(),
  };
}
