import { signWebhookPayload, verifyWebhookSignature } from '@ai-concierge/security';
import { AppError, QuoteErrorCode, type QuoteSnapshot } from '@ai-concierge/domain';

/**
 * Recursively sorts object keys (arrays keep their order — order is
 * semantically meaningful for a list of line items, never for an object's
 * own field names) before serializing. Plain `JSON.stringify` on a snapshot
 * fresh out of `PricingCalculator` would happen to match signing order, but
 * a snapshot *read back* from Postgres `jsonb` is not guaranteed to
 * preserve original key insertion order — `jsonb` normalizes on storage.
 * Without this, `verifyQuoteIntegrity` could report a false `TAMPERED` for a
 * snapshot nobody touched, purely from a harmless key-order difference
 * introduced by the database round-trip. Exported so `QuoteService`'s
 * duplicate-quote comparison (packages/ai has no DB dependency, so that
 * comparison lives in apps/api) can reuse the same order-independent
 * equality instead of a second, possibly-inconsistent implementation.
 */
export function canonicalJSONStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const sorted: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      sorted[key] = sortKeysDeep(entryValue);
    }
    return sorted;
  }
  return value;
}

/**
 * Every price-bearing/identity field, explicitly listed in a fixed order —
 * not `JSON.stringify` on the whole snapshot, whose key order is an
 * incidental implementation detail, not a security-relevant contract.
 * Deliberately excludes `integrityHash` itself (what it signs),
 * `requiresHumanReview`/`reviewReasons` (a review flag changing shouldn't
 * itself look like tampering with the *price*), `modelMetadata`, and
 * `createdAt` (a timestamp column, not a price fact).
 */
export function canonicalizeForIntegrity(
  snapshot: Pick<
    QuoteSnapshot,
    | 'quoteId'
    | 'version'
    | 'status'
    | 'currency'
    | 'lineItems'
    | 'taxes'
    | 'fees'
    | 'discounts'
    | 'deposit'
    | 'total'
    | 'validUntil'
    | 'pricingVersion'
  >,
): string {
  return canonicalJSONStringify({
    quoteId: snapshot.quoteId,
    version: snapshot.version,
    status: snapshot.status,
    currency: snapshot.currency,
    lineItems: snapshot.lineItems,
    taxes: snapshot.taxes,
    fees: snapshot.fees,
    discounts: snapshot.discounts,
    deposit: snapshot.deposit,
    total: snapshot.total,
    validUntil: snapshot.validUntil,
    pricingVersion: snapshot.pricingVersion,
  });
}

/**
 * Step 8 — tamper detection. Reuses Phase 1's own HMAC-SHA256
 * primitive (`packages/security/webhookSignature.ts`, already
 * constant-time-compared and tested against forgery) rather than inventing
 * a parallel hashing utility. Signed with `config.WEBHOOK_SIGNING_SECRET` —
 * a deliberate reuse of the one existing app-level HMAC secret (Phase 1's
 * own `.env.example` already describes it as the generic placeholder,
 * distinct from a per-channel secret like `WHATSAPP_APP_SECRET`), not a new
 * required secret every deployment would need to additionally configure —
 * see PHASE-8.md §3.
 */
export function signQuoteSnapshot(
  snapshot: Parameters<typeof canonicalizeForIntegrity>[0],
  secret: string,
): string {
  return signWebhookPayload(canonicalizeForIntegrity(snapshot), secret);
}

export function verifyQuoteIntegrity(snapshot: QuoteSnapshot, secret: string): boolean {
  return verifyWebhookSignature(canonicalizeForIntegrity(snapshot), snapshot.integrityHash, secret);
}

export function isQuoteExpired(snapshot: QuoteSnapshot, now: Date): boolean {
  return new Date(snapshot.validUntil).getTime() <= now.getTime();
}

/**
 * Read-time enforcement: a caller that reads a `Quote` row directly (e.g. a
 * future admin screen) and skips this gets no protection — same posture as
 * every other `AppError`-throwing validator in this codebase
 * (`validateAvailabilityRequest`, etc.). Checks tamper before expiry: if the
 * content doesn't match its own signature, `validUntil` itself cannot be
 * trusted either.
 */
export class QuoteValidator {
  constructor(private readonly integritySecret: string) {}

  validate(snapshot: QuoteSnapshot, now: Date = new Date()): void {
    if (!verifyQuoteIntegrity(snapshot, this.integritySecret)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Quote integrity check failed — stored content does not match its own signature',
        {
          details: {
            code: QuoteErrorCode.QUOTE_TAMPERED,
            quoteId: snapshot.quoteId,
            version: snapshot.version,
          },
        },
      );
    }
    if (isQuoteExpired(snapshot, now)) {
      throw new AppError('VALIDATION_FAILED', 'Quote has expired', {
        details: {
          code: QuoteErrorCode.QUOTE_EXPIRED,
          quoteId: snapshot.quoteId,
          version: snapshot.version,
          validUntil: snapshot.validUntil,
        },
      });
    }
  }
}
