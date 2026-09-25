# Phase 14 — Quote / Pricing Engine (journey Step 8)

Status: **FROZEN**

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`, `docs/MASTER-PLAN.md`,
  `docs/DESIGN-SYSTEM.md` (this phase touches no UI, so read for context only).
- Read `docs/PHASE-13.md` (previous phase doc — journey Step 7, Alternatives).
- Inspected the repository; local PostgreSQL 16 + Redis 7 started (no Docker daemon in this
  sandbox, same as every prior phase) and confirmed reachable; ran the existing suite before
  changing anything — baseline **541 unit + 205 integration + 79 security tests, all green**
  (exactly Phase 7's own final numbers).
- Reviewed `MASTER-PLAN.md` §1 (target architecture) and §6 (cross-cutting standards) before and
  after implementation (architecture review, §9).

**Phase-numbering reconciliation (same discipline `docs/PHASE-12.md`/`docs/PHASE-13.md` §1 used —
read this before anything else).** The task named this "PHASE 8" with a spec that is, word for
word, `MASTER-PLAN.md` §4 journey Step 08 ("Quote", `QUOTE_ISSUED`, "SYS" owner: "pricing engine:
base rate, duration tiers, extras, deposit, VAT 5%; quote expiry"). `PHASE-CONTRACTS.json`'s
literal id-8 entry is "Customer Mobile App (PWA)" — unrelated, zero overlap.

Following the exact precedent ids 11-13 established (append at the next free integer, `dependsOn`
reflecting real functional dependency, not journey order): this phase is **id 14**. Its actual
dependency is `[4]`, not `[12]` (Availability) or `[13]` (Alternatives) — this phase's
`QuoteService` never calls `AvailabilityProvider`/`ReservationLockService`; it only reads Steps
2-3's already-persisted dates/vehicle. MASTER-PLAN's own side-effect note for Step 8 ("expiry timer
→ `QUOTE_EXPIRED`, release hold") describes a _future_ integration with Step 6's hold, not something
this phase builds — see §2 "Out of scope" and §9.

**Escalation-tier correction.** The task described "large discounts/custom deals/pricing anomalies"
review as "Tier 2/exception-agent" scope. `MASTER-PLAN.md` §4's own escalation-tier legend is
explicit: **"T3 Manager (approval, pricing exceptions, disputes)"** — T2 is "Ops agent (documents,
delivery, return, support)". This phase follows the existing, already-defined taxonomy (T3) rather
than introduce a conflicting tier label; the mechanism requested (flag a quote for human review) is
built exactly as asked, just correctly labeled — see §3.

## 2. Scope

Goal: given a conversation's already-resolved Step 3 vehicle and Step 2 dates, deterministically
compute a complete, immutable, versioned, tamper-evident price quote — "AI must NEVER invent
prices," decimal-safe money, human review for anomalies.

**In scope:**

- `Money` value object (integer minor units — fils — never floating-point arithmetic for financial
  totals).
- `PricingRules`: base rate + duration tiers (weekly-rate blending), extras, delivery, insurance,
  VAT, service fee, discount codes, default deposit, quote validity window, human-review threshold.
- `PricingCalculator` (pure, deterministic, zero AI/LLM calls): base rental → extras → delivery →
  insurance → discount → fees → VAT → total.
- `PricingAnomalyDetector`: flags a quote `PENDING_REVIEW` for a large discount, a (currently
  unreachable, seam-only) manual override, or a zero total — Tier 3 (Manager) scope per §1.
- `QuoteValidator`: tamper detection (HMAC over the quote's own priced content) and expiry.
- `QuoteSnapshot`: immutable per version; a "change" always inserts a new row
  (`quoteId` stable, `version + 1`), same append-only-history convention as
  `VehicleDetermination`/`AvailabilityCheck`/`AlternativeRecommendation`.
- Two HTTP endpoints: `POST /v1/enquiries/:conversationId/quote` (generate/re-quote),
  `GET /v1/enquiries/:conversationId/quote` (read the current quote, tamper/expiry-checked).
- Concurrency-safe versioning (`pg_advisory_xact_lock`, same pattern as Step 6's
  `acquireVehicleLock`) and idempotent duplicate-quote detection.
- Required test scenarios: 4 days; fees; tax; discount; rounding; zero/negative values; currency
  mismatch; expired quote; duplicate quote; concurrent quote generation — plus security: price
  manipulation prevention, authorization (tenant isolation), audit trail, tamper detection.

**Out of scope (deferred, not started):**

- Wiring Quote to Step 6's `AvailabilityHold` (MASTER-PLAN's "quote expiry → release hold") — this
  phase's `QuoteService` never reads or writes an `AvailabilityHold`; a quote and a hold exist
  independently today. Left to the user to decide how the two should connect.
- A DB-backed, tenant-configurable, versioned `PricingRules` (the same shape Step 5's
  `EligibilityPolicy` uses) — this phase's `PricingRules` is an in-code, single-tenant config object
  with a `version` string, not a database table. No credentials/external integration is involved, so
  there is nothing to report `NOT_CONFIGURED` — see §9.
- A real "custom deal" input channel — `PricingAnomalyDetector` accepts a `hasManualOverride` flag,
  but no privileged/staff endpoint exists yet to legitimately set it (no AuthN/AuthZ system exists in
  this codebase at all — `PHASE-CONTRACTS.json` id-6 scope). Documented seam, not a live path.
- Multi-currency: `PricingRules.currency` is fixed to `AED` per the task's own "Currency: AED
  initially." A vehicle priced in any other currency is a hard `CURRENCY_MISMATCH` failure, not a
  conversion.
- Location/distance-based delivery pricing — `deliveryFee` is a flat rate; the fleet catalog has no
  branch/location field yet (same gap `docs/PHASE-13.md` §9 already noted).
- Wiring this into the WhatsApp auto-pipeline — ships as a standalone endpoint, same posture Phases
  5-7 took for their own endpoints.
- `PHASE-CONTRACTS.json` id-6 "Security Engine & Zero Trust" and id-8 "Customer Mobile App (PWA)" —
  unrelated, unchanged, still fully `PENDING`.

## 3. Design decisions

- **`Money`: integer minor units (fils), two controlled float boundaries, both documented and
  tested.** `fromMajorUnits` is the one place a pre-existing float (e.g.
  `Vehicle.pricingProfile.dailyRate`) is rounded into an exact integer; `multiplyByRate`
  (percentages) does an exact integer multiply then a single explicit `Math.round` division. No
  other operation ever touches a float. This directly closes the "money is a JS float, not integer
  minor units" gap `docs/PHASE-13.md` §9 flagged as inherited from Phase 3 — fixed here for all of
  this phase's own money handling (Phase 3's `pricingProfile.dailyRate` field itself is unchanged;
  Phase 3 is frozen and this phase only _consumes_ that field, converting it at the one controlled
  boundary).
- **Calculation order: discount before tax, despite the task's literal word order listing "tax"
  before "discount."** Taxing a pre-discount amount would overcharge VAT relative to what is
  actually paid — standard invoicing practice applies the discount to the taxable base first. The
  task's list reads as the ingredients to handle, not a mandated pipeline order (it also lists "base
  rental, duration" as if separate, when duration is a multiplier applied to the rate, not its own
  line item).
- **Duration tiers: blend the weekly rate for full weeks, daily rate for the remainder — only when
  `Vehicle.pricingProfile.weeklyRate` is actually set** (an existing, optional Phase 3 field). Never
  fabricates a weekly discount for a vehicle that doesn't have one.
- **A currency mismatch surfaces from `Money.add`'s own guard, not a separate check.** The first
  cross-currency arithmetic (accumulating vehicle-currency line items into a rules-currency total)
  throws `AppError` with `details.code: CURRENCY_MISMATCH` by construction — one less place for the
  check to be forgotten.
- **Price-manipulation prevention: `quoteSelectionsSchema` (`.strict()`) has no money field at all.**
  A client selects _which_ extras/insurance tier/discount code/delivery flag — identifiers and
  booleans only. The server resolves every one of them against its own `PricingRules`; an unknown
  code is rejected (`UNKNOWN_EXTRA_CODE`/`UNKNOWN_DISCOUNT_CODE`), never silently priced at whatever
  the client implied. Proven directly: a request body carrying `total`/`lineItems`/any unrecognized
  field is rejected at the Zod boundary before any pricing logic runs (§8).
- **Tamper detection reuses Phase 1's own HMAC primitive
  (`packages/security/webhookSignature.ts`)**, signed with `config.WEBHOOK_SIGNING_SECRET` — the one
  existing general-purpose app-level HMAC secret (Phase 1's `.env.example` already describes it as a
  generic placeholder, distinct from a per-channel secret like `WHATSAPP_APP_SECRET`), not a new
  required secret every deployment would need to additionally configure.
- **Canonical JSON serialization recursively sorts object keys before signing/comparing — found
  necessary by this phase's own design review, not assumed correct.** Postgres `jsonb` does not
  guarantee preserving original key insertion order; a naive `JSON.stringify` on a snapshot read back
  from the database could report a false `QUOTE_TAMPERED` for a row nobody touched, purely from a
  harmless key-order difference introduced by the storage round-trip. `canonicalJSONStringify`
  (`packages/ai/src/step8/quoteValidator.ts`) fixes this; a dedicated test proves a
  reordered-but-identical snapshot still verifies (§8).
- **Concurrency-safe versioning reuses Step 6's exact `pg_advisory_xact_lock` pattern**
  (`acquireConversationQuoteLock`, namespaced with a `:quote:` segment so its hash space never
  collides with `acquireVehicleLock`'s). The "is there already a latest version, does it still
  apply" decision happens _inside_ the lock, after re-reading — the same "re-check inside the lock"
  discipline Phase 6's own tests found necessary for `ReservationLockService.placeHold`.
- **"Duplicate quote" = an existing, unexpired, untampered quote whose priced content is
  byte-identical to what a fresh calculation would produce** — returned as-is, never a wasteful new
  version for terms that haven't changed. A side effect proven directly: N concurrent identical
  requests for a brand-new conversation converge on a single `quoteId`/version (§8) — the lock
  prevents two independent `quoteId`s, and duplicate-detection then collapses every request after
  the first winner onto that same row.
- **A row that fails its own integrity check is never trusted for anything — not reused as a
  "duplicate," not extended as the next version.** `createQuote` treats a tampered existing row as
  equivalent to "no trustworthy quote exists yet," audits a `quote.tamper_detected` event, and starts
  a fresh `quoteId` lineage rather than building on or silently repairing corrupted data.
- **Staleness re-validation — found by this phase's own `/code-review`, not assumed safe.** The
  first version read Step 2's `pickupDate`/`returnDate` straight into duration math with no check
  that they were still sane _now_ — the same staleness class Step 6's own orchestrator already
  re-checks on every run ("time can pass before this step executes"), and Step 8 runs even later in
  the journey. Fixed by reusing Step 6's own `validateAvailabilityRequest` (not a second
  implementation of the same check) right after confirming dates are resolved; a stale pickup or a
  return date that's no longer after pickup now fails fast with a clear `AppError` instead of
  silently clamping to a 1-day quote. Two regression tests prove the exact failure scenarios (§8).
- **`moneySchema` independently enforces non-negativity — found by the same review pass.** The
  `Money` class constructor already rejected a negative amount, but the Zod schema every `Quote` row
  is re-validated against on read (`toDomainQuoteSnapshot`) did not — relying solely on the separate
  `integrityHash` check to catch a negative amount written some other way (a migration, a manual
  fix, a future admin tool) than through the application. Fixed with `.nonnegative()`.
- **The `GET` endpoint exists so `QuoteValidator` has a real caller, not a dormant, untested-in-
  production class.** `createQuote`'s own tamper check is intentionally non-throwing (a tampered
  _existing_ row just means "treat as no quote yet"); `getQuote` is where a clean throw-and-fail is
  exactly right — the one place a customer/system reads a quote back without regenerating it.

## 4. What was built

- `packages/domain/src/money.ts` — `Money` (integer-minor-unit value object), `moneySchema`,
  `sumMoney`.
- `packages/domain/src/quote.ts` — `InsuranceTier`, `quoteSelectionsSchema` (`.strict()`),
  `QuoteLineItemCategory`, `quoteLineItemSchema`/`quoteTaxLineSchema`/`quoteFeeLineSchema`/
  `quoteDiscountLineSchema`, `QuoteStatus`, `QuoteErrorCode`, `quoteSnapshotSchema`.
- `packages/ai/src/step8/` — `pricingRules.ts` (`PricingRules`, `DEFAULT_PRICING_RULES`),
  `pricingCalculator.ts` (`calculatePricing`, `computeRentalDurationDays`),
  `pricingAnomalyDetector.ts` (`detectPricingAnomalies`), `quoteValidator.ts`
  (`canonicalJSONStringify`, `signQuoteSnapshot`, `verifyQuoteIntegrity`, `isQuoteExpired`,
  `QuoteValidator`) + matching `.test.ts` for each + `test/fixtures.ts`.
- `packages/db/prisma/schema.prisma` — `QuoteStatus` enum, `Quote` model + relations on
  `Tenant`/`Conversation`/`Message`/`Vehicle`; migrations `20260923225940_add_quote_pricing` and
  `20260924033124_add_quotes_tenant_index`.
- `packages/db/src/repositories/quoteRepository.ts` — `acquireConversationQuoteLock`,
  `createQuote`, `findLatestQuoteForConversation`, `toDomainQuoteSnapshot` + tests.
- `apps/api/src/services/quoteService.ts` — `createQuote`, `getQuote`.
- `apps/api/src/routes/v1/quote.ts` — `POST`/`GET /v1/enquiries/:conversationId/quote`.
- `apps/api/src/context.ts`, `server.ts`, `test/buildTestApp.ts` — `pricingRules`/`quoteValidator`
  wired into `AppContext`.
- `packages/contracts/src/quote.ts` — request/response schemas for both endpoints.
- `packages/testing/src/db.ts` — `quotes` added to the truncation list.
- `docs/PHASE-14.md` (this file), `docs/PHASE-CONTRACTS.json` (id 14, see §1).

No changes to Steps 1-7's own logic, the WhatsApp channel, or the auto-pipeline.

## 5. APIs

| Method | Path                                  | Purpose                                                                         |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/v1/enquiries/:conversationId/quote` | Generates or re-quotes; returns the current (possibly duplicate-reused) version |
| GET    | `/v1/enquiries/:conversationId/quote` | Reads the current quote — tamper/expiry-checked, never silently stale           |

`POST` takes a `.strict()` body (`extraCodes`, `insuranceTier`, `deliveryRequested`,
`discountCode` — every field optional/defaulted); `GET` takes no body. 400
`VEHICLE_NOT_RESOLVED`/`DATES_NOT_RESOLVED`/`PICKUP_DATE_NOW_IN_PAST`/
`RETURN_BEFORE_OR_EQUAL_PICKUP`/`UNKNOWN_EXTRA_CODE`/`UNKNOWN_DISCOUNT_CODE`/`CURRENCY_MISMATCH`;
404 `QUOTE_NOT_FOUND`/unknown conversation; `GET` additionally 400
`QUOTE_EXPIRED`/`QUOTE_TAMPERED`. Schemas: `packages/contracts/src/quote.ts`; live in the OpenAPI
doc at `/docs`.

## 6. Database schema

Two additive migrations:

- `20260923225940_add_quote_pricing` — `QuoteStatus` enum, `Quote` (`quotes`) table (append-only,
  `@@unique([tenantId, quoteId, version])`), relations on `Tenant`/`Conversation`/`Message`/`Vehicle`.
- `20260924033124_add_quotes_tenant_index` — `@@index([tenantId])`, added during this phase's own
  code review to match the indexing convention every sibling table (`AvailabilityCheck`,
  `AlternativeRecommendation`) already follows.

No existing column/table changed. Verified via `prisma migrate dev` against a real local dev
database, then `prisma migrate deploy` against the test database; both migrations' SQL reviewed
directly (only `CREATE TYPE`/`CREATE TABLE`/`CREATE INDEX`/`ADD CONSTRAINT` statements).

## 7. Security decisions

**Implemented and tested:**

- **Price manipulation prevention** — the request boundary (`quoteSelectionsSchema`, `.strict()`)
  has no money field; every amount is server-computed from `PricingRules` + the already-resolved
  vehicle. Proven directly: a body carrying `total`, `lineItems[].amount`, or any unrecognized field
  is rejected before pricing runs.
- **Tamper detection** — every `QuoteSnapshot` carries an HMAC-SHA256 `integrityHash` over its own
  priced content; `GET` refuses to serve a snapshot whose stored content doesn't match its signature,
  and `POST` never builds the next version on top of one. Proven with a test that edits a stored
  `Quote` row's `total` directly (the only way a real tamper could happen — there is no update
  endpoint) and confirms it's refused, not silently served.
- **Authorization (tenant isolation)** — every repository query is tenant-scoped; a quote/vehicle
  belonging to one tenant is never reachable through another tenant's conversation id. Real
  user-level RBAC does not exist in this codebase yet (`PHASE-CONTRACTS.json` id-6 scope) — tenant
  isolation is the one authorization boundary that exists today, and it's what's proven here.
- **Audit trail** — `quote.issued` on every new version, `quote.tamper_detected` when an existing row
  fails its integrity check, both written in the same transaction as the mutation they record.
- **Never leaks internal detail** — 400/404 responses carry only a stable `AppError` code +
  `details.code`, never a stack trace, SQL fragment, or driver message.
- **No untrusted raw input reaches pricing math** — extras/discount codes are looked up against
  server-side `PricingRules`, never used to compute an amount directly; a SQL-injection-shaped
  original customer message is proven inert end to end.

**Explicitly deferred (documented, not silently skipped):**

- Database-level Row Level Security, real AuthN/AuthZ — unchanged from every prior phase; still
  `PHASE-CONTRACTS.json` id-6 scope.
- The "custom deal" human-review path has no live, privileged caller yet (§2) — the detector
  supports it, nothing can legitimately trigger it today.

## 8. Test results

All commands run against real local PostgreSQL 16 + Redis 7 (no Docker daemon in this sandbox).

| Gate                | Command                              | Result                                                                                                                                                                                                    |
| ------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck           | `pnpm typecheck`                     | ✅ every package + app                                                                                                                                                                                    |
| Lint                | `pnpm lint`                          | ✅ 0 errors, 0 warnings                                                                                                                                                                                   |
| Format              | `pnpm format:check`                  | ✅ clean                                                                                                                                                                                                  |
| Unit                | `pnpm test:unit`                     | ✅ 599 tests (+58 from baseline)                                                                                                                                                                          |
| Integration         | `pnpm test:integration`              | ✅ 232 tests (+27 from baseline)                                                                                                                                                                          |
| Security            | `pnpm test:security`                 | ✅ 91 tests (+12 from baseline)                                                                                                                                                                           |
| E2E                 | `pnpm test:e2e`                      | ✅ 4 tests, unchanged (no UI touched)                                                                                                                                                                     |
| Build               | `pnpm build`                         | ✅ every package + Next.js production build                                                                                                                                                               |
| Code review         | `/code-review` (high)                | ✅ 3 findings, all fixed + regression-tested: missing staleness re-check (reused Step 6's own validator), `moneySchema` missing `.nonnegative()`, `Quote` missing the sibling-table `@@index([tenantId])` |
| Architecture review | checklist vs `MASTER-PLAN.md` §1, §6 | ✅ matches target layering; this phase's own money handling now satisfies §6's "integer minor units, never floats" (closing the gap `docs/PHASE-13.md` §9 flagged as inherited from Phase 3)              |
| Regression          | `pnpm test` (final commit)           | ✅ full Phase 1-7 + this phase, all green                                                                                                                                                                 |

**Total: 926 automated tests, all passing** (599 unit + 232 integration + 91 security + 4 e2e).

Every explicitly required test case, mapped to where it's proven:

| Case                        | How it's proven                                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 days                      | `pricingCalculator.test.ts` (pure) + `quote.integration.test.ts` "4 days" — exact total against a real HTTP round-trip                                                                                                  |
| Fees                        | `pricingCalculator.test.ts` + `quote.integration.test.ts` — `SERVICE_FEE` line present and exact                                                                                                                        |
| Tax                         | `pricingCalculator.test.ts` + `quote.integration.test.ts` — VAT line at the configured rate                                                                                                                             |
| Discount                    | `pricingCalculator.test.ts` + `quote.integration.test.ts` — `WELCOME10` applied to the subtotal, not the fee                                                                                                            |
| Rounding                    | `money.test.ts` (round-half-up proven directly) + `pricingCalculator.test.ts` + `quote.integration.test.ts` — a `dailyRate` chosen to force a real fractional-fil VAT computation                                       |
| Zero/negative values        | `money.test.ts` (negative rejected at both the class and schema boundary, subtraction clamps at zero) + `pricingCalculator.test.ts`/`quote.integration.test.ts` (an oversized discount never produces a negative total) |
| Currency mismatch           | `pricingCalculator.test.ts` + `quote.integration.test.ts` — a USD-priced vehicle against AED rules fails `CURRENCY_MISMATCH`, surfaced by `Money.add`'s own guard                                                       |
| Expired quote               | `quoteValidator.test.ts` (tamper checked before expiry) + `quote.integration.test.ts` — an already-expired existing quote is never reused, and `GET` reports `QUOTE_EXPIRED`                                            |
| Duplicate quote             | `quote.integration.test.ts` "duplicate quote" — an identical, unexpired repeat request returns the same `quoteId`/version, no new row                                                                                   |
| Concurrent quote generation | `quoteRepository.test.ts` (lock serialization, lost-update proof) + `quote.integration.test.ts` — 8 truly concurrent identical requests converge on one `quoteId`/version, one DB row                                   |

Security: price manipulation prevention, authorization (tenant isolation), audit trail, and tamper
detection each have dedicated tests in `quote.security.test.ts` (§7). Human review: large discount →
`PENDING_REVIEW` + `reviewReasons`, tested in both `pricingAnomalyDetector.test.ts` (unit) and
`quote.integration.test.ts` (end to end).

## 9. Known limitations

- **`PricingRules` is in-code config, not a DB-backed, tenant-configurable, versioned policy** — see
  §2. The same shape Step 5's `EligibilityPolicy` uses is a natural next step, not built here.
- **No live caller can legitimately set `hasManualOverride`** ("custom deals" human review) — no
  privileged/staff input channel exists in this codebase yet.
- **AED only** — matches the task's own "Currency: AED initially"; a different-currency vehicle is a
  hard failure, not a conversion.
- **Quote and Availability hold are independent** — MASTER-PLAN's "quote expiry → release hold" is
  not wired; a quote expiring does not affect any `AvailabilityHold`, and vice versa.
- **Flat delivery fee, no location/distance pricing** — the fleet catalog has no branch/location
  field yet (same gap `docs/PHASE-13.md` §9 noted).
- **Not wired into the WhatsApp auto-pipeline** — standalone endpoints, same posture every prior
  phase's own endpoints took before any pipeline chaining existed.
- **`PricingAnomalyDetector`'s discount-percent message uses a float division for display text only**
  (the boolean threshold decision itself is exact integer cross-multiplication) — a display-formatting
  choice, not a financial total.
- Every limitation Phases 1-7 already listed and didn't explicitly note as fixed here is still open
  (no database-level RLS, keyword-based English-only intent classification, no per-sender rate limit
  beyond the API-wide one, `MetaWhatsAppProvider`/`ExternalFleetApiProvider` untested against their
  real external counterparts, no Docker daemon in this sandbox).

## 10. Files created

- `packages/domain/src/{money,quote}.ts` + matching `.test.ts`
- `packages/ai/src/step8/{pricingRules,pricingCalculator,pricingAnomalyDetector,quoteValidator}.ts` + matching `.test.ts` + `test/fixtures.ts`
- `packages/db/prisma/migrations/{20260923225940_add_quote_pricing,20260924033124_add_quotes_tenant_index}/`
- `packages/db/src/repositories/quoteRepository.ts` + `.test.ts`
- `apps/api/src/services/quoteService.ts`
- `apps/api/src/routes/v1/quote.ts`
- `apps/api/src/quote.integration.test.ts`, `apps/api/src/quote.security.test.ts`
- `packages/contracts/src/quote.ts`
- `docs/PHASE-14.md` (this file)

## 11. Files modified

- `packages/db/prisma/schema.prisma` (+ `Quote` model/enum, relations on
  `Tenant`/`Conversation`/`Message`/`Vehicle`)
- `packages/ai/src/index.ts`, `packages/db/src/index.ts`, `packages/domain/src/index.ts`,
  `packages/contracts/src/index.ts` — new exports
- `packages/testing/src/db.ts` — `quotes` added to `truncateAllTables`
- `apps/api/src/context.ts`, `server.ts`, `app.ts`, `test/buildTestApp.ts` — services wired through,
  routes registered
- `docs/PHASE-CONTRACTS.json` — updated for this phase (id 14, see §1)

No working Phase 1-7 functionality was changed; `pnpm test` (full regression) re-run green on the
final commit.

## 12. Migration status

Two additive migrations this phase (see §6). No down-migration needed — every change is a new
table/enum/index; reverting the code is safe without reverting the schema.

## 13. Next steps (proposed, not started)

Per `docs/PHASE-13.md` §13 and `MASTER-PLAN.md` §4, several threads remain open, none started here:

1. Wiring Quote to Step 6's `AvailabilityHold` (expiry → release) and to the WhatsApp auto-pipeline.
2. A DB-backed, tenant-configurable, versioned `PricingRules` (mirrors `EligibilityPolicy`).
3. Journey Step 9 (Documents) or `PHASE-CONTRACTS.json` id-6 "Security Engine & Zero Trust" — the
   first real AuthN/AuthZ system, which is also the prerequisite for a genuine "custom deal" staff
   input channel.
4. `PHASE-CONTRACTS.json` id-8 "Customer Mobile App (PWA)" — unrelated, unchanged, still fully
   `PENDING`.

Do not start any of these until asked.
