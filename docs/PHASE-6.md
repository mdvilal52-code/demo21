# Phase 6 — Availability (journey Step 6)

Status: **FROZEN**

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`, `docs/MASTER-PLAN.md`,
  `docs/DESIGN-SYSTEM.md` (this phase touches no UI, so read for context only).
- Read `docs/PHASE-4.md` and `docs/PHASE-5.md` (previous phase docs).
- Inspected the repository; local PostgreSQL 16 + Redis 7 started and confirmed reachable; ran the
  existing suite before changing anything — baseline 329 unit + 104 integration + 44 security
  tests, all green.

**Phase-numbering reconciliation (read this before anything else in this doc).** The task named
this "PHASE 6" with a detailed, unambiguous spec: real inventory availability, `AvailabilityProvider`
/`FleetProvider`/`ReservationLockService`, states AVAILABLE/HELD/BOOKED/UNAVAILABLE/MAINTENANCE/
UNKNOWN, holds with TTL, race-condition/idempotency/transaction safety. `PHASE-CONTRACTS.json`'s
literal id-6 entry at the time was "Security Engine & Zero Trust" — an unrelated, pre-journey-
numbering placeholder (WAF, AuthN/AuthZ, RLS, AI sandbox, PII encryption) with zero overlap with
the request. Three independent pieces of evidence resolved this before any code was written,
without needing to ask:

1. Phases 1-4 already established that this file's real numbering is **journey steps** from
   `MASTER-PLAN.md` §4 (1=Enquiry, 2=Dates/Location, 3=Vehicle, 4=Missing Info), not the original
   10-phase infra grouping — `PHASE-CONTRACTS.json`'s own top-level `phaseNumbering` note says so
   explicitly and says ids 5-10 "will be reconciled...as work reaches them".
2. The codebase **already forward-references "journey Step 6" as this exact feature**, written
   before this phase started: `packages/db/prisma/schema.prisma`'s `VehicleAvailabilityStatus` enum
   doc comment says "Real per-date availability/holds are journey Step 6, a distinct later phase";
   `packages/domain/src/vehicle.ts` says the same almost verbatim, citing `PHASE-2.md §13`.
3. Precedent: Phase 5 (WhatsApp) was **also** explicitly requested out of the "logical" journey
   order (before Eligibility, journey Step 5) and documented that discrepancy transparently rather
   than blocking on it (`docs/PHASE-5.md` §1, §13).

Given all three agree and the literal id-6 content shares nothing with the request, this is a
journey-Step-6 delivery, continuing exactly the pattern phases 1-4 set — not `PHASE-CONTRACTS.json`
id 6's old placeholder. `PHASE-CONTRACTS.json` has been updated to match: the new phase now sits at
`id: 6` (continuing the journey-step sequence), and the old id-6..10 placeholders (Security Engine,
Admin Dashboard, Mobile PWA, Observability, Infra) shifted to ids 7-11 with their content
**unchanged** — the same "absorb the old grouping into the real sequence" move already made for
ids 1-4's own predecessor content. Journey Step 5 (Eligibility) remains explicitly skipped and
`PENDING`, same as Phase 5 left it.

## 2. Scope

Goal: given a conversation whose Step 3 vehicle and Step 2 dates are already resolved, authoritatively
decide real inventory availability and place a TTL'd reservation lock — never a guess, never told to
a customer unless the lock-protected claim itself confirms it.

**In scope:**

- `AvailabilityProvider`, `FleetProvider`, `ReservationLockService` — the three named provider
  abstractions, all real and tested.
- Real, database-backed inventory (`VehicleUnit`), a capacity-based (not unit-assigned) reservation
  model (`AvailabilityHold`), and an append-only check history (`AvailabilityCheck`).
- An external fleet API adapter interface (`ExternalFleetApiProvider`) + `NotConfiguredFleetProvider`
  — real adapter code, honestly reporting `NOT_CONFIGURED` since no such third-party system exists to
  integrate with here (same posture as WhatsApp/Payment providers in earlier phases).
- Temporary reservation locks with TTL and expiration (lazy + swept), race-condition protection
  (pessimistic advisory lock), idempotency (unique key + in-lock re-check), transaction safety, and
  both optimistic and pessimistic locking, each applied where its shape actually fits (see §3).
- Timezone correctness: UTC storage throughout, buffer/overlap math on absolute instants only.
- One HTTP endpoint: `POST /v1/enquiries/:conversationId/availability-check`.
- A worker housekeeping sweep for lapsed holds.

**Out of scope (deferred, not started):**

- Wiring this into `runFullEnquiryPipeline`/the WhatsApp auto-pipeline (Phase 5) — this phase adds
  the Step 6 endpoint standalone, matching how Steps 2-4 each shipped as their own endpoint before
  any pipeline chaining existed.
- Journey Step 5 (Eligibility) — still not built; this phase explicitly jumped ahead of it (§1).
- Journey Step 7 (Alternatives) — `AvailabilityProvider`/`AvailabilityCheckOrchestrator` are built
  and tested as the seam it will need (a non-committal multi-vehicle preview), but nothing calls
  them yet; see §3's "dead code" note.
- The real Booking entity (journey Step 14) — a `CONFIRMED` `AvailabilityHold` stands in as the
  permanent calendar block for now; `ReservationLockService.confirmHold` exists but nothing calls it
  yet (no booking-confirmation flow exists to call it from).
- `PHASE-CONTRACTS.json` id-7 "Security Engine & Zero Trust" (RLS, AuthN/AuthZ, WAF) — unrelated,
  unchanged, still fully `PENDING`.

## 3. Design decisions

- **Capacity-based, not unit-assigned inventory.** `VehicleUnit` rows give a real, countable
  physical-fleet size per (tenant, vehicle); a hold blocks one unit of that count for a date range,
  never a specific physical car — the same model hotel room-type inventory uses. Simpler than
  per-unit assignment and equally real: a customer never cares *which* Urus they get, only that one
  exists.
- **Two provider layers doing the same computation, on purpose.** `AvailabilityProvider` (a
  non-committal read) and `ReservationLockService.placeHold` (the authoritative, lock-protected
  claim) both call the same `evaluateInventoryStatus` (`apps/api/src/services/
  inventoryStatusEvaluator.ts`) — vehicle lookup → `FleetProvider` snapshot → buffered/lazily-
  expiring overlap count → the pure `computeInventoryStatus`. They can never silently compute
  "available" differently; the only difference is whether a lock was held and a row written. "Never
  tell a customer a vehicle is available unless the authoritative source confirms it" is enforced by
  construction: the one HTTP endpoint in this phase always calls `placeHold`, never the preview
  alone.
- **Pessimistic locking for the scarce resource; optimistic locking for a single row.**
  `placeHold` acquires `pg_advisory_xact_lock(tenantId, vehicleId)` before recomputing capacity —
  every concurrent request for the *same vehicle* serializes, so overselling is structurally
  impossible, not just unlikely (proven by this phase's own concurrent-booking/race-condition
  tests, up to 10-way concurrency on a single unit). `releaseHold`/`confirmHold` instead use
  `AvailabilityHold.version` (optimistic): once a hold exists, nothing else contends for *that
  specific row* in the common case, so a cheap compare-and-swap is enough — a racing loser sees 0
  rows affected and a `CONFLICT`, never a silent no-op. "Where appropriate" means matching the lock
  strategy to which of those two shapes — shared scarce resource vs. a single row — actually applies.
- **Idempotency needs an in-lock re-check, not just a pre-lock one — found by this phase's own
  tests, not assumed correct.** The obvious design (check-by-idempotency-key before the transaction,
  as a fast path) has a real race: two concurrent requests with the *same* key can both miss that
  check and both reach the transaction. Whichever acquires the advisory lock second must recognize
  the first one's now-committed row as its own request replaying — otherwise, once capacity is
  tight, it gets counted as a *competing* reservation and the genuine retry is wrongly rejected as
  UNAVAILABLE. Fixed by re-checking `findHoldByIdempotencyKey` again *inside* the lock, before the
  capacity computation runs; a second, narrower safety net (catching the unique-constraint
  violation on insert) covers the one remaining sliver. Caught by this phase's own
  concurrent-duplicate-request test before it shipped, not found later.
- **Lazy expiration applied consistently, not just where it was easy — the other bug this phase's
  own code review caught.** `countOverlappingHolds` correctly treats an `ACTIVE` hold past its
  `expiresAt` as not counting toward capacity, without waiting for the background sweep. The first
  version of `confirmHold` checked only `status === 'ACTIVE'`, not `expiresAt` — so a hold already
  being lazily ignored for capacity purposes could still be confirmed by a sufficiently delayed
  caller (e.g. a late payment webhook), creating two permanent holds against one unit of capacity:
  exactly the oversell this service exists to prevent. Fixed by having `confirmHold` apply the same
  `expiresAt` check explicitly. A regression test proves the exact failure scenario (place a
  lapsed hold, let a second customer legitimately take the freed capacity, then attempt to confirm
  the lapsed one — must be rejected, not silently succeed).
- **`ReservationLockService.placeHold` validates the request itself, not just its caller.** The
  class's own contract is "never trust a caller's belief about availability"; the first version
  only validated dates (`returnAt > pickupAt`, `pickupAt` not already in the past) in
  `availabilityService.ts`, one layer up. A future or different caller of `placeHold` directly
  would have bypassed that check entirely. Fixed by calling `validateAvailabilityRequest` at the
  top of `placeHold` itself; the HTTP service's own earlier check is now a redundant, harmless
  fast-fail (a clear 400 without touching the DB), with `placeHold`'s check as the real backstop.
- **A worker housekeeping sweep, not a BullMQ job.** `expireDueHolds` needs no retry/at-least-once/
  persistence guarantees — it's a single idempotent bulk `UPDATE`, safe to run on any interval or
  even skip a beat entirely (correctness never depends on it, only on the lazy-expiration check
  above). A plain `setInterval` in `apps/worker` achieves the same outcome with less machinery than
  wiring a repeatable BullMQ job for a task that doesn't need the queue's guarantees.
- **Redis assists, database remains source of truth.** `CachedFleetProvider` caches an *external*
  `FleetProvider`'s unit-count facts for a short TTL (never applied to the default `DatabaseFleetProvider`
  — a fast local read, caching it would only add staleness risk for no benefit) — and never caches
  hold/booking state, which always lives in and is read fresh from Postgres inside `placeHold`'s
  locked transaction. A Redis outage degrades to "call the inner provider every time", never a
  fabricated snapshot.
- **`AvailabilityProvider`/`AvailabilityCheckOrchestrator` exist, tested, but are deliberately not
  wired into any live route in this phase.** Flagged by this phase's own `/code-review` as
  effectively dead DI wiring (`AppContext.availabilityOrchestrator` had no reader). Fixed by
  removing that DI wiring (the class + its own test still exist, since the user's spec explicitly
  asked for `AvailabilityProvider` to exist as a real component) — it's the seam a future
  multi-vehicle preview (journey Step 7, Alternatives) will use to check several candidates without
  placing a hold against each one; forcing a call site into today's single endpoint before that
  need exists would be exactly the "design for hypothetical future requirements" this repo's own
  standards warn against.
- **`ctx.fleetProvider` stays on `AppContext`** even though no route reads it directly today —
  mirrors `ctx.whatsappProvider`'s existing role (constructed for real use, also exposed for a
  future admin-Settings "provider status" screen, Phase 8/`PHASE-CONTRACTS.json` id 8).
- **`VehicleAvailabilityStatus === MAINTENANCE` is re-checked at Step 6 time, not assumed from Step
  3.** Step 3 already refuses to resolve a vehicle already under maintenance at determination time
  (`VEHICLE_UNAVAILABLE`); the realistic way Step 6 ever sees `MAINTENANCE` is a status change
  *after* Step 3 ran (an admin action) — exactly the "never trust an earlier step's read is still
  true now" discipline Step 6's own staleness check (previous bullet) already applies to dates.
  Proven with a test that resolves the vehicle first, then flips it to maintenance, then checks.

## 4. What was built

- `packages/domain/src/availability.ts` — `InventoryStatus`, `HoldStatus`, `AvailabilityErrorCode`,
  `holdSchema`, `availabilityCheckResultSchema`.
- `packages/ai/src/step6/` — `fleetProvider.ts` (`FleetProvider`, `FleetProviderError`),
  `resilientFleetProvider.ts` (timeout/circuit-breaker/rate-limit wrapper, mirrors Step 2's
  `ResilientLocationProvider`), `availabilityCalculator.ts` (pure `computeInventoryStatus`,
  `rangesOverlapWithBuffer`), `availabilityProvider.ts` (`AvailabilityProvider` seam),
  `orchestrator.ts` (`AvailabilityRequestError`, `validateAvailabilityRequest`,
  `AvailabilityCheckOrchestrator`).
- `packages/db/prisma/schema.prisma` — `UnitStatus`, `VehicleUnit`, `InventoryStatus`, `HoldStatus`,
  `AvailabilityHold`, `AvailabilityCheck` + relations; migration
  `20260923154421_add_availability_inventory`.
- `packages/db/src/repositories/` — `vehicleUnitRepository.ts` (`countUnitsByStatus`,
  `createVehicleUnit`, `listUnitsForVehicle`), `availabilityHoldRepository.ts`
  (`acquireVehicleLock`, `countOverlappingHolds`, `insertHold`, `findHoldByIdempotencyKey`,
  `findHoldById`, `updateHoldStatus`, `expireDueHolds`, `toDomainHold`,
  `isUniqueConstraintViolation`), `availabilityCheckRepository.ts` (`createAvailabilityCheck`,
  `findLatestAvailabilityCheckForMessage`).
- `apps/api/src/services/` — `fleetProvider.ts` (`DatabaseFleetProvider`, `ExternalFleetApiProvider`,
  `NotConfiguredFleetProvider`), `cachedFleetProvider.ts` (`CachedFleetProvider`),
  `createFleetProvider.ts` (env-driven factory), `inventoryStatusEvaluator.ts`
  (`evaluateInventoryStatus`, shared by both classes below), `availabilityProvider.ts`
  (`PrismaAvailabilityProvider`), `reservationLockService.ts` (`ReservationLockService`),
  `availabilityService.ts` (`checkAvailability`, the HTTP-facing service).
- `apps/api/src/routes/v1/availability.ts` — `POST /v1/enquiries/:conversationId/availability-check`.
- `apps/api/src/env.ts` — `FLEET_PROVIDER`, `FLEET_API_BASE_URL`, `FLEET_API_KEY`,
  `FLEET_API_TIMEOUT_MS`, `AVAILABILITY_HOLD_TTL_SECONDS`, `AVAILABILITY_TURNAROUND_BUFFER_MINUTES`
  (all optional with working defaults; `FLEET_PROVIDER=database` needs zero configuration).
- `apps/api/src/context.ts`, `server.ts`, `test/buildTestApp.ts` — `fleetProvider` +
  `reservationLockService` wired into `AppContext`.
- `apps/worker/src/jobs/holdExpirationSweep.ts` + `env.ts`
  (`HOLD_EXPIRATION_SWEEP_INTERVAL_MS`) + `worker.ts` wiring.
- `packages/contracts/src/availability.ts` — `checkAvailabilityParamsSchema`,
  `checkAvailabilityResponseSchema`.
- `packages/db/src/seed.ts` — starter fleet now also seeds `VehicleUnit` rows (Urus × 2, Range
  Rover × 3).
- `packages/testing/src/db.ts` — `vehicle_units`/`availability_holds`/`availability_checks` added
  to the truncation list.
- `.env.example`, `render.yaml` — new variables documented.
- `docs/ARCHITECTURE.md`, `docs/PHASE-CONTRACTS.json` — updated (see §1 for the numbering change).

No changes to Steps 1-4's own logic, the WhatsApp channel, or the auto-pipeline.

## 5. APIs

| Method | Path                                              | Purpose                                                                          |
| ------ | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/v1/enquiries/:conversationId/availability-check` | Authoritatively checks + holds inventory for the conversation's resolved vehicle/dates |

Input is the conversation id only (no request body) — matching Steps 2-4's convention of reading
whatever the previous steps already resolved, never raw text or a fresh body. 400
`VEHICLE_NOT_RESOLVED`/`DATES_NOT_RESOLVED` if Step 3/Step 2 haven't run yet; 400
`PICKUP_DATE_NOW_IN_PAST`/`RETURN_BEFORE_OR_EQUAL_PICKUP` if the previously-resolved dates have
since gone stale; 404 for an unknown/cross-tenant conversation. Request/response schemas:
`packages/contracts/src/availability.ts`; live in the OpenAPI doc at `/docs`.

## 6. Database schema

New migration `packages/db/prisma/migrations/20260923154421_add_availability_inventory/`:

- `VehicleUnit` (`vehicle_units`) — physical countable inventory, `@@unique([tenantId, vehicleId, unitRef])`.
- `AvailabilityHold` (`availability_holds`) — the reservation lock, `@@unique([tenantId, idempotencyKey])`,
  `version` for optimistic locking.
- `AvailabilityCheck` (`availability_checks`) — append-only check history, same convention as
  `IntentRecord`/`DateLocationExtraction`/`VehicleDetermination`/`MissingInfoCheck`.
- New enums `UnitStatus`, `InventoryStatus`, `HoldStatus`.
- Relations added to `Tenant`, `Vehicle`, `Message`.

All additive — no existing column/table changed. Verified on a genuinely fresh database: both the
dev and test databases were newly created (`CREATE DATABASE`) at the start of this session and the
full migration history (five pre-existing migrations + this one) applied cleanly via
`prisma migrate deploy` before any other work began. `prisma migrate reset` (a destructive
drop-and-replay) was not additionally run — Prisma's own AI-safety guard requires explicit user
consent for that specific command, and the fresh-database deploy already run gives the same
assurance without the added risk.

## 7. Security decisions

**Implemented and tested:**

- **Least-privilege outbound egress.** `ExternalFleetApiProvider` calls only its configured host via
  `ssrfSafeFetch` (DNS-rebinding/private-address checks, no redirect following) — same discipline as
  `MetaWhatsAppProvider`.
- **Never a fake success.** Every `FleetProvider` failure (timeout, non-2xx, unrecognized response
  shape, not configured) throws `FleetProviderError` rather than fabricating a snapshot; every such
  failure surfaces as `UNKNOWN` + `retryable`, never a guessed AVAILABLE/UNAVAILABLE.
- **Tenant isolation** — every repository query scoped by `tenantId` explicitly (application-level,
  unchanged posture from Phases 1-5; database-level RLS is still `PHASE-CONTRACTS.json` id 7,
  untouched). Proven with dedicated tests at the repository, service, and HTTP layers: a hold/lookup
  for one tenant is never visible to or consumable by another, even when both have identically-named
  fleets; `releaseHold`/`confirmHold` reject a hold id belonging to another tenant as `NOT_FOUND`.
- **No untrusted raw input reaches this step.** The endpoint takes no body; its only inputs are
  already-Zod-validated Step 2/3 persisted results and the path's `conversationId` (UUID-validated).
  A SQL-injection-shaped customer message is proven inert end to end (through Steps 1-3 into this
  step) without a body for this step's own tests to attack directly.
- **Never leaks internal detail.** 404/400 responses carry only a stable `AppError` code +
  `details.code`, never a stack trace, SQL fragment, or driver message — checked explicitly by regex
  in the security tests.
- **Audit event on every mutation** — hold creation (via `availability.checked`), `confirmHold`
  (`availability_hold.confirmed`), `releaseHold` (`availability_hold.released`), each written in the
  same transaction as the mutation it records; found missing for confirm/release during this
  phase's own architecture-review pass (protocol's "audit events on every mutation" is
  non-negotiable) and added before freeze, with a dedicated test.
- **Race-condition/concurrency correctness is a security property here, not just a UX one** — a
  broken lock would let an attacker (or just an unlucky customer) claim more capacity than exists,
  a real business-logic vulnerability. Proven under real concurrency (`Promise.all`, up to 10-way),
  not just asserted.

**Explicitly deferred (documented, not silently skipped):**

- Database-level Row Level Security — unchanged from every prior phase; still `PHASE-CONTRACTS.json`
  id 7 scope.
- `ExternalFleetApiProvider` is untested against a real third-party fleet system (none exists to
  integrate with here) — unit-tested against a fake `fetch`, reports `NOT_CONFIGURED` until real
  credentials are supplied, per the "never fake a working integration" rule (same posture as
  `MetaWhatsAppProvider` in Phase 5).

## 8. Test results

All commands run against real local PostgreSQL 16 + Redis 7 (no Docker daemon in this sandbox, same
as every prior phase).

| Gate                | Command                        | Result                                                                                       |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Typecheck           | `pnpm typecheck`                | ✅ every package + app                                                                          |
| Lint                | `pnpm lint`                     | ✅ 0 errors, 0 warnings                                                                         |
| Format              | `pnpm format:check`             | ✅ clean                                                                                        |
| Unit                | `pnpm test:unit`                | ✅ 473 tests                                                                                    |
| Integration         | `pnpm test:integration`         | ✅ 165 tests                                                                                    |
| Security            | `pnpm test:security`            | ✅ 63 tests                                                                                     |
| E2E                 | `pnpm test:e2e`                 | ✅ 4 tests, unchanged (no UI touched)                                                           |
| Build               | `pnpm build`                    | ✅ every package + Next.js production build                                                    |
| Code review         | `/code-review` (high)           | ✅ 5 findings — 2 real bugs fixed (§3) + regression tests, 1 duplication eliminated (shared `evaluateInventoryStatus`), 1 dead DI wiring removed, 1 phase-numbering process note (already addressed in §1) |
| Architecture review | checklist vs MASTER-PLAN §1/§6  | ✅ matches target layering; self-caught the missing audit events on confirm/release (§7), fixed before freeze |
| Regression          | `pnpm test` (final commit)      | ✅ full Phase 1-5 suite + this phase's, all green                                               |

**Total: 705 automated tests, all passing** (473 unit + 165 integration + 63 security + 4 e2e).

Key new scenarios, mapped to every explicitly required test case
(`apps/api/src/services/reservationLockService.integration.test.ts` unless noted):

| Case                         | How it's proven                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Concurrent booking           | N-unit vehicle, N+1 truly concurrent (`Promise.all`) requests — exactly N `HELD`, 1 `UNAVAILABLE`             |
| Double booking               | Sequential second request for a fully-held vehicle — `UNAVAILABLE`, exactly one `ACTIVE` row in the DB        |
| Expired hold                 | A hold created already-lapsed (`ttlSeconds: -1`) no longer blocks a new request; `expireDueHolds` sweep proven separately in `packages/db`; `confirmHold`-on-lapsed-hold regression (§3) |
| API timeout                  | A `FleetProvider` that never resolves — result races a local timeout and never wins; `ResilientFleetProvider` unit tests prove the production timeout wrapper directly |
| Provider failure             | A `FleetProvider` that throws — `UNKNOWN` + `retryable`, zero rows written; a subsequent call with a recovered provider succeeds normally |
| Duplicate request            | Same idempotency key called twice, sequentially and concurrently — one row, second call is `ALREADY_HELD` with the same hold id |
| Race condition               | Capacity 1, 10 truly concurrent requests — exactly 1 `HELD`, 9 `UNAVAILABLE`                                  |
| Tenant isolation             | Two tenants filling their own identically-shaped fleets independently; cross-tenant vehicle id → `UNAVAILABLE`; cross-tenant `releaseHold`/`confirmHold` → `NOT_FOUND` (also proven at the HTTP layer in `availability.security.test.ts` and the repository layer in `packages/db`) |

Plus: 16 pure unit tests for `computeInventoryStatus`/`rangesOverlapWithBuffer` (every state
transition, buffer edge cases, offset-vs-UTC instant equivalence), 6 for `ResilientFleetProvider`
(timeout/circuit-breaker/rate-limit each proven directly), 8 for `DatabaseFleetProvider`/
`ExternalFleetApiProvider`/`NotConfiguredFleetProvider`, 4 for `CachedFleetProvider` (hit/miss/
Redis-failure-fallback/per-tenant-scoping), a full HTTP-level golden-path + precondition-failure
suite (`availability.integration.test.ts`), and a dedicated security suite covering tenant
isolation, error-leakage, and injection-inertness at the HTTP layer.

## 9. Known limitations

- **Not wired into the WhatsApp auto-pipeline or any other channel** — this phase ships the Step 6
  endpoint standalone, same as how Steps 2-4 each shipped before any pipeline chaining existed.
  Left to the user to decide whether/when to chain it into `runFullEnquiryPipeline`.
- **`AvailabilityProvider`/`AvailabilityCheckOrchestrator` have no live caller yet** (§3) — built and
  tested as the seam journey Step 7 (Alternatives) will need, deliberately not force-wired before
  that need exists.
- **`ReservationLockService.confirmHold`/`releaseHold` have no live caller yet either** — journey
  Step 14 (the real Booking entity) is what will call `confirmHold`; nothing in the customer-facing
  flow triggers a booking confirmation yet. Both methods are fully implemented, audited, and tested
  directly.
- **One test-suite-ordering artifact, not a product defect**: in
  `reservationLockService.integration.test.ts`, the "provider failure" test measures ~9.8s when run
  after the file's own high-concurrency tests (10-way and 4-way `Promise.all` against a
  `connection_limit=25` pool), but 151ms when run in isolation — confirmed connection-pool
  settling residue from the preceding concurrency tests, not a latency bug in the reservation logic
  itself (verified by running the test alone).
- **Production connection-pool sizing is an operational concern, not something this phase's tests
  paper over.** `placeHold`'s advisory-lock serialization means a queued transaction holds a pool
  connection for as long as it waits; the integration test suite explicitly raises its own test
  client's `connection_limit` to 25 to drive realistic concurrency rather than silently reducing the
  concurrency level to fit the default pool size. A production deployment expecting many
  simultaneous requests against the *same* hot vehicle should size its connection pool accordingly
  — a deployment/runbook note, not a code change.
- **No Docker daemon in this dev sandbox** (same as every prior phase) — `docker-compose.yml`
  unaffected.
- Every limitation Phases 1-5 already listed and didn't explicitly note as fixed here is still open
  (no database-level RLS, keyword-based English-only intent classification, no per-sender rate
  limit beyond the API-wide one, `MetaWhatsAppProvider`/now also `ExternalFleetApiProvider` untested
  against their real external counterparts, no Docker daemon in this sandbox).

## 10. Files created

- `packages/domain/src/availability.ts`
- `packages/ai/src/step6/{fleetProvider,resilientFleetProvider,availabilityCalculator,availabilityProvider,orchestrator}.ts` + matching `.test.ts`
- `packages/db/prisma/migrations/20260923154421_add_availability_inventory/`
- `packages/db/src/repositories/{vehicleUnitRepository,availabilityHoldRepository,availabilityCheckRepository}.ts` + `.test.ts`
- `apps/api/src/services/{fleetProvider,cachedFleetProvider,createFleetProvider,inventoryStatusEvaluator,availabilityProvider,reservationLockService,availabilityService}.ts` + `.test.ts`/`.integration.test.ts`
- `apps/api/src/routes/v1/availability.ts`
- `apps/api/src/availability.integration.test.ts`, `apps/api/src/availability.security.test.ts`
- `apps/worker/src/jobs/holdExpirationSweep.ts` + `.test.ts`
- `packages/contracts/src/availability.ts`
- `docs/PHASE-6.md` (this file)

## 11. Files modified

- `packages/db/prisma/schema.prisma` (+ relations on `Tenant`/`Vehicle`/`Message`)
- `packages/db/src/index.ts`, `packages/ai/src/index.ts`, `packages/domain/src/index.ts`,
  `packages/contracts/src/index.ts` — new exports
- `packages/db/src/seed.ts` — `VehicleUnit` seeding
- `packages/testing/src/db.ts` — new tables added to `truncateAllTables`
- `apps/api/src/env.ts`, `context.ts`, `server.ts`, `app.ts`, `test/buildTestApp.ts` — Phase 6 config/
  providers/service wired through
- `apps/worker/src/env.ts`, `worker.ts` — sweep wiring
- `.env.example`, `render.yaml` — new optional variables documented
- `docs/ARCHITECTURE.md`, `docs/PHASE-CONTRACTS.json` — updated for this phase (see §1)

No working Phase 1-5 functionality was changed; `pnpm test` (full regression) re-run green on the
final commit.

## 12. Migration status

One additive migration this phase (see §6). No down-migration needed — every change is a new
table/enum; reverting the code is safe without reverting the schema (unused tables, not broken
ones).

## 13. Next steps (proposed, not started)

Per `docs/PHASE-4.md`/`docs/PHASE-5.md`'s own forward notes and `MASTER-PLAN.md` §4, several
threads remain open, none started here:

1. Journey Step 5 (Eligibility) — still the "logically next" journey step per the original
   sequence, still skipped twice now (once by Phase 5, again by this phase).
2. Journey Step 7 (Alternatives) — would be the first real caller of `AvailabilityProvider`/
   `AvailabilityCheckOrchestrator`.
3. Wiring Step 6 into the WhatsApp auto-pipeline (`runFullEnquiryPipeline`), so a real conversation
   gets an availability answer automatically after Step 3 resolves a vehicle.
4. The rest of `PHASE-CONTRACTS.json` id-5's original scope (Web chat/Email adapters, documents,
   payments, CRM, delivery/return) — still `PENDING`, untouched.
5. `PHASE-CONTRACTS.json` id-7 "Security Engine & Zero Trust" — unrelated, unchanged, still fully
   `PENDING`.

Do not start any of these until asked.
