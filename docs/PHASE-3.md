# Phase 3 — Determine Vehicle (journey Step 3)

Status: **FROZEN**

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`, `docs/MASTER-PLAN.md`
  (no UI changes this phase, so `docs/DESIGN-SYSTEM.md` has nothing to apply).
- Read `docs/PHASE-2.md` (previous phase) and its §13 forward contract for Phase 3.
- Inspected the repository; local PostgreSQL 16 + Redis 7 confirmed reachable; ran the existing
  Phase 1 + Phase 2 suite before changing anything (245/250-test baseline green).

## 2. Scope

Goal: journey Step 3 — **Determine Vehicle** — end to end: map the customer's vehicle preference
(exact model, brand only, category only, or a typo) to a real fleet catalog entry, deterministically
verified against the tenant's actual inventory (never invented) — same AI-proposes/domain-verifies
split as Steps 1–2, with an explicit third component (`VehicleCatalogService`) standing for "database
is authoritative."

Input: a conversation's latest `Message.content` (the same conversation Phase 1 created and Phase 2
may have already processed — read the same way, never raw text re-parsed at this layer). Output
(`VehicleDetermination` row + API response): `status` (`RESOLVED`/`NEEDS_CLARIFICATION`/`UNSUPPORTED`),
`resolvedVehicle`, `confidence`, `ambiguities`, `validationErrors`, `alternatives`, plus
`flags`/`modelMetadata` for consistency with Phases 1–2.

Out of scope (deferred): a real-time per-date availability calendar and holds (journey Step 6), the
real pricing engine with duration tiers/extras/VAT (Step 8 — `pricingProfile` here is only the
"budget hint" MASTER-PLAN's Step 3 row calls for), a fleet-management admin UI/CRUD API (Phase 7's
"Fleet & availability" deliverable), and the real Event/Workflow Engine sequencing journey steps
(still Phase 4+, per Phase 2's §13 note — unchanged).

## 3. Design decisions

- **Three services, one orchestrator, matching the exact split asked for.** `VehicleIntentService`
  (pure, zero I/O) proposes match candidates from text; `VehicleCatalogService` is the only class
  that talks to the real fleet (via an injected `VehicleCatalogProvider`); `VehicleValidationService`
  (pure, zero I/O) is the sole deterministic decision-maker and the only place a
  `VehicleDeterminationResult` is constructed — always through
  `vehicleDeterminationResultSchema.parse`. `VehicleDeterminationOrchestrator` wires all three.
- **The matching lexicon always comes from the database, never a hardcoded list.** `VehicleIntentService`
  only ever proposes a `lexiconEntryId` that was in the `VehicleLexiconEntry[]` it was handed;
  `VehicleCatalogService.getLexicon` sources that list from the tenant's real `Vehicle` rows. There is
  no compiled-in make/model list anywhere in the matching code — "never invent inventory" is an
  architectural property, not a convention to remember.
- **Tenant-scoped provider seam, unlike Step 2's global gazetteer.** `VehicleCatalogProvider` takes
  `tenantId` on every method rather than being fixed at construction time, because a fleet is
  per-tenant (Step 2's Dubai/UAE gazetteer was deliberately tenant-agnostic). The concrete
  `PrismaVehicleCatalogProvider` lives in `apps/api` (the composition root already depending on both
  `@ai-concierge/ai` and `@ai-concierge/db`), keeping `packages/ai` itself free of any DB dependency —
  same layering Step 2 used for `LocationProvider`.
- **Tiered, mutually-exclusive matching**: exact model → brand only → category only → typo-tolerant
  fuzzy, in that order, each tier short-circuiting the next. This maps directly onto the four required
  test scenarios (exact vehicle / brand only / category only / typos) as distinct, independently
  testable code paths rather than one blended scoring function.
- **Typo tolerance is a small, self-written Levenshtein implementation** (`packages/ai/src/step3/levenshtein.ts`),
  not a new npm dependency — same "no unnecessary dependency" call Phase 2 made for DST handling.
  A candidate phrase is accepted only above a similarity threshold (0.75) and never at similarity 1
  (that would just be an exact match already caught by an earlier tier).
- **Sentence-initial capitalization is not a proper-noun signal.** English capitalizes the first word
  of every sentence regardless of meaning ("What time...", "I want..."), so a naive "any capitalized
  word might be a vehicle name" heuristic falsely flagged ordinary questions as unknown-vehicle
  mentions. Fixed by requiring either two consecutive capitalized words (a strong signal at any
  position, e.g. "Toyota Corolla") or a single capitalized word away from the very start of the text —
  caught by, and regression-tested via, `vehicleIntentService.test.ts` and `orchestrator.test.ts`.
- **Three distinct, non-overlapping "not available" states**, each answering a different question:
  `deletedAt` (soft-deleted — behaves as if the vehicle never existed, excluded from the matching
  lexicon entirely), `active` (a real catalog entry, currently disabled by the business — still
  matchable by name, reported as `VEHICLE_INACTIVE`), `availabilityStatus` (a real, active entry
  that's temporarily `UNAVAILABLE`/`MAINTENANCE` — reported as `VEHICLE_UNAVAILABLE`). Conflating any
  two of these would either leak a deleted row's name or misreport a real outage as "unknown".
- **`Vehicle` is a fleet class/model catalog entry, not a per-unit record.** Matches MASTER-PLAN's
  Step 3 wording ("map preference to fleet class / model") exactly — no VIN/individual-unit tracking
  was invented; the unique identity constraint is `(tenantId, make, model)`, with both normalized to a
  consistent title case at the repository layer so "lamborghini"/"Lamborghini"/"LAMBORGHINI" collide
  without needing the `citext` extension.
- **Alternatives always widen when the narrow search comes up empty.** `VehicleCatalogService.resolve`
  first asks for alternatives scoped to the failed candidate's category, then retries unfiltered if
  that comes back empty (e.g. the only vehicle in that category was the inactive one just asked
  about) — found via a failing integration test during this phase, not assumed correct up front; a
  customer is never left with zero suggestions when a real one exists elsewhere in the active fleet.
- **No resilience-wrapping (timeout/circuit-breaker/rate-limiter) on the catalog provider.** Unlike
  Step 2, Step 3 makes no external network call at all — it's a plain internal Postgres read via
  Prisma — so wrapping it in primitives designed for flaky external providers would be unmotivated
  complexity, not a security requirement. `packages/security/resilience.ts` remains available,
  unchanged, for the day a real availability/pricing provider needs it.
- **No fleet-management HTTP API.** Create/soft-delete/query are repository-level functions, fully
  integration-tested, with no public CRUD endpoint — matches "do only the current phase" scoping;
  managing a fleet through the UI is Phase 7's "Fleet & availability" deliverable.
- **New API endpoint, not a body-accepting one**, matching Step 2's pattern exactly:
  `POST /v1/enquiries/:conversationId/vehicle-selection` (the name matches MASTER-PLAN's
  `VEHICLE_SELECTION` state) takes no request body — it operates on the conversation's already-stored
  message.

## 4. What was built

- `packages/domain/src/vehicle.ts` — `VehicleCategory`, `LuxuryTier`, `Transmission`,
  `VehicleAvailabilityStatus`, `VehicleMatchType`, `VehicleDeterminationStatus`,
  `pricingProfileSchema`, `vehicleSchema`, `VehicleAmbiguityCode`/`VehicleValidationErrorCode` +
  schemas, `vehicleDeterminationResultSchema`.
- `packages/ai/src/step3/` — `levenshtein.ts`, `categoryKeywords.ts`, `vehicleCatalogProvider.ts`
  (the `VehicleCatalogProvider`/`VehicleLexiconEntry` seam), `vehicleIntentService.ts`,
  `vehicleCatalogService.ts`, `vehicleValidationService.ts`, `orchestrator.ts`
  (`VehicleDeterminationOrchestrator`).
- `packages/db`: `Vehicle` + `VehicleDetermination` models, `VehicleCategory`/`LuxuryTier`/
  `Transmission`/`VehicleAvailabilityStatus`/`VehicleDeterminationStatus` enums (migration
  `20260916030354_add_vehicle_catalog`), `vehicleRepository.ts` (create/soft-delete/lexicon/lookup/
  alternatives, with a Prisma→domain mapper that re-validates via `vehicleSchema`),
  `vehicleDeterminationRepository.ts`.
- `packages/contracts/src/vehicle.ts` — request/response schemas for the new endpoint.
- `apps/api`: `services/vehicleCatalogProvider.ts` (`PrismaVehicleCatalogProvider`),
  `services/vehicleService.ts`, `routes/v1/vehicle.ts`
  (`POST /v1/enquiries/:conversationId/vehicle-selection`), `vehicleOrchestrator` added to
  `AppContext`.
- `packages/testing/src/db.ts` — `vehicles`/`vehicle_determinations` added to the truncation list.

## 5. APIs

| Method | Path                                              | Purpose                                                                           |
| ------ | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/v1/enquiries/:conversationId/vehicle-selection` | Run Step 3 against the conversation's latest message; persist + return the result |

Request/response schemas: `packages/contracts/src/vehicle.ts`; live in the OpenAPI doc at `/docs`.

## 6. Database schema

`Vehicle` (`VehicleCategory`: SEDAN/SUV/COUPE/CONVERTIBLE/SPORTS/VAN; `LuxuryTier`: PREMIUM/LUXURY/
ULTRA_LUXURY; `Transmission`: AUTOMATIC/MANUAL; `VehicleAvailabilityStatus`: AVAILABLE/UNAVAILABLE/
MAINTENANCE) and `VehicleDetermination` (`VehicleDeterminationStatus`: RESOLVED/NEEDS_CLARIFICATION/
UNSUPPORTED) — see `packages/db/prisma/schema.prisma` and
`packages/db/prisma/migrations/20260916030354_add_vehicle_catalog/`.

- `Vehicle`: `@@unique([tenantId, make, model])`, `deletedAt DateTime?` (soft delete), tenant-scoped
  indexes. Every repository query filters `deletedAt: null`; nothing in the codebase issues a hard
  `DELETE` on this table.
- `VehicleDetermination`: same append-only-history convention as `IntentRecord`/
  `DateLocationExtraction` — one row per determination run, storing the Zod-validated engine output
  verbatim, `resolvedVehicleId` nullable (null whenever status isn't `RESOLVED`).

## 7. Security decisions

**Implemented and tested:**

- **Never invent inventory** — the core guarantee of this phase. `VehicleIntentService` only proposes
  ids present in the DB-sourced lexicon; `VehicleCatalogService` only ever returns real rows;
  `VehicleValidationService` never fabricates a `resolvedVehicle` or an alternative. Proven directly:
  a prompt-injection payload asking for a free "Bugatti Chiron" is flagged but never satisfied, at
  every layer (unit, orchestrator, and live HTTP).
- **Tenant isolation** — every repository function takes `tenantId` explicitly and filters by it;
  proven with a dedicated cross-tenant test (a vehicle seeded under one tenant is invisible to
  another's lexicon/lookup/alternatives) plus an API-level defense-in-depth test mirroring Phase 2's.
- **Structured errors on the unique-identity constraint** — a duplicate `(tenantId, make, model)`
  raises `AppError('CONFLICT', ...)` from the repository layer, never a raw Prisma driver error
  reaching a caller.
- **Zod at the read boundary too** — `findVehiclesByIds`/`findAlternativeVehicles` re-validate every
  row against `vehicleSchema` before it leaves `packages/db`, not just at write time; cheap insurance
  against a stored `pricingProfile` JSON column drifting out of shape after a future schema change.
- **Audit events** — every vehicle-determination run writes an `AuditEvent` (`vehicle.determined`) in
  the same Prisma transaction as the `VehicleDetermination` row.
- **Prompt-injection detection** — reused Phase 1's `sanitizeForProcessing`, no new implementation;
  the sanitizer's `[REMOVED]` placeholder is explicitly stripped before vehicle-phrase matching so it
  can never itself be mistaken for a vehicle mention.
- **SQL injection** — Prisma parameterized queries only; proven with a payload embedded directly in
  the enquiry message reaching this endpoint end to end.

**Explicitly deferred (documented, not silently skipped):**

- Database-level Row Level Security — still application-level only, unchanged from Phases 1–2.
- Timeouts/circuit-breaker/rate-limiting on the catalog provider — not applicable yet (no external
  network call exists in this phase); `packages/security/resilience.ts` is ready for the day a real
  availability/pricing provider needs it, the same seam Step 2 already proved out.
- RBAC/authz on a future fleet-management API — no such API exists yet (Phase 6/7 scope).

## 8. Test results

All commands run against real local PostgreSQL 16 + Redis 7 (same sandbox as Phases 1–2; Docker
daemon still unavailable here).

| Gate        | Command                 | Result                                             |
| ----------- | ----------------------- | -------------------------------------------------- |
| Typecheck   | `pnpm typecheck`        | ✅ 11/11 packages                                  |
| Lint        | `pnpm lint`             | ✅ 0 errors, 0 warnings                            |
| Format      | `pnpm format:check`     | ✅ clean                                           |
| Unit        | `pnpm test:unit`        | ✅ 260 tests (was 185 in Phase 2 — 75 new)         |
| Integration | `pnpm test:integration` | ✅ 53 tests (was 32 — 21 new)                      |
| Security    | `pnpm test:security`    | ✅ 33 tests (was 29 — 4 new)                       |
| E2E         | `pnpm test:e2e`         | ✅ 4 tests, unchanged from Phase 1 (no UI touched) |
| Build       | `pnpm build`            | ✅ every package + Next.js production build        |

**Total: 350 automated tests, all passing** — the full Phase 1 + Phase 2 suite re-run and green
(regression requirement), plus Phase 3's new coverage.

Every explicitly required test case passes, most directly in `packages/ai/src/step3/*.test.ts` (unit,
zero I/O) and `packages/ai/src/step3/orchestrator.test.ts` (in-memory fake catalog, end to end through
the real orchestrator), and again through the live HTTP API in
`apps/api/src/vehicle.integration.test.ts` / `vehicle.security.test.ts`:

| Case              | Where                                        | Result                                                                                        |
| ----------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| exact vehicle     | intent service + orchestrator + API          | `EXACT_MODEL`, resolves cleanly                                                               |
| brand only        | intent service + orchestrator + API          | `BRAND_ONLY`, resolves when unambiguous, else `NEEDS_CLARIFICATION`                           |
| category only     | intent service + orchestrator + API          | `CATEGORY_ONLY`, resolves when unambiguous, else `NEEDS_CLARIFICATION` with real alternatives |
| typos             | intent service + orchestrator + API          | `FUZZY_MATCH` above a similarity threshold, never guessed below it                            |
| unknown vehicle   | intent service + orchestrator + API          | `UNKNOWN_VEHICLE`, `UNSUPPORTED`, real alternatives offered                                   |
| injection         | orchestrator + API (security)                | `flags.promptInjectionDetected`, never fabricates the asked-for vehicle                       |
| inactive vehicle  | validation service + orchestrator + API      | `VEHICLE_INACTIVE`, `UNSUPPORTED`, real alternatives offered                                  |
| duplicate vehicle | `vehicleRepository.test.ts`                  | `AppError('CONFLICT', ...)`, case-insensitively                                               |
| tenant isolation  | `vehicleRepository.test.ts` + API (security) | invisible to lexicon/lookup/alternatives; 404 defense-in-depth                                |

## 9. Known limitations

- **Matching is regex/keyword + edit-distance, not true NLP** — same class of heuristic as Phases 1–2;
  non-English phrasing correctly falls through to `NO_VEHICLE_MENTIONED`/`UNKNOWN_VEHICLE` rather than
  a wrong guess, but isn't specifically resolved.
- **`CATEGORY_KEYWORDS` is a small, fixed English vocabulary** — extending it (or supporting other
  languages) is additive data, not an architecture change.
- **`availabilityStatus` is a coarse catalog-level flag, not a booking calendar.** Real per-date
  availability with holds/buffers is journey Step 6, a distinct later phase.
- **`pricingProfile` is a "budget hint"**, not the real pricing engine (duration tiers, extras, 5% VAT)
  — that is Step 8 (`QUOTE_ISSUED`).
- **No fleet-management HTTP/admin API** — create/soft-delete are repository-level and
  integration-tested only; a real UI is Phase 7's "Fleet & availability" deliverable.
- **Full `prisma migrate reset` (destructive up/down/up replay) was not performed.** Prisma's own
  AI-safety guard requires explicit human consent for that action; it was not sought since this
  phase's migration cleanliness was already demonstrated via a successful sequential
  `migrate dev` (dev DB) / `migrate deploy` (test DB) apply, the same forward-path convention as
  Phases 1–2's own migrations.
- **No Docker daemon in this dev sandbox** (same as Phases 1–2) — `docker-compose.yml` unaffected and
  correct for normal local/CI use.

## 10. Files created

- `packages/domain/src/vehicle.ts`, `packages/domain/src/vehicle.test.ts`
- `packages/ai/src/step3/*.ts` and matching `*.test.ts` (levenshtein, categoryKeywords,
  vehicleCatalogProvider, vehicleIntentService, vehicleCatalogService, vehicleValidationService,
  orchestrator)
- `packages/db/prisma/migrations/20260916030354_add_vehicle_catalog/migration.sql`
- `packages/db/src/repositories/vehicleRepository.ts` (+ `.test.ts`)
- `packages/db/src/repositories/vehicleDeterminationRepository.ts` (+ `.test.ts`)
- `packages/contracts/src/vehicle.ts` (+ `.test.ts`)
- `apps/api/src/services/vehicleCatalogProvider.ts`
- `apps/api/src/services/vehicleService.ts` (+ `.test.ts`)
- `apps/api/src/routes/v1/vehicle.ts`
- `apps/api/src/vehicle.integration.test.ts`, `apps/api/src/vehicle.security.test.ts`
- `docs/PHASE-3.md` (this file)

## 11. Files modified

- `packages/ai/src/index.ts`, `packages/domain/src/index.ts`, `packages/contracts/src/index.ts`,
  `packages/db/src/index.ts` — new exports added.
- `packages/db/prisma/schema.prisma` — added `Vehicle`/`VehicleDetermination` models and their
  enums, relations from `Tenant`/`Message`.
- `packages/testing/src/db.ts` — `vehicles`/`vehicle_determinations` added to `TABLES`.
- `apps/api/src/context.ts`, `apps/api/src/server.ts`, `apps/api/src/test/buildTestApp.ts`,
  `apps/api/src/app.ts` — `vehicleOrchestrator` wired into `AppContext`; new route registered.
- `docs/ARCHITECTURE.md`, `docs/PHASE-CONTRACTS.json` — updated for Phase 3.

No working Phase 1/2 functionality was changed; no dead code was found to remove (`npx depcheck`
clean on every touched package, no leftover TODOs/console.log).

## 12. Migration status

One new migration applied and verified on both dev and test databases:
`20260916030354_add_vehicle_catalog` (forward migration path exercised via `prisma migrate dev` /
`prisma migrate deploy`, same convention as Phases 1–2). See Known Limitations for why a full
destructive reset-and-replay was not additionally performed.

## 13. Phase 4 contract (proposed inputs for the next phase)

Per `MASTER-PLAN.md` §4, journey Step 4 is **Ask missing information** (`COLLECTING_MISSING_INFO`,
looping until complete or a 24h timeout). Per `PHASE-CONTRACTS.json`'s `phaseNumbering` note, the
document's current phase-id-4 entry ("AI Orchestrator & Provider Abstraction") is the original
10-phase-breakdown placeholder, not yet reconciled with the journey-step numbering Phases 1–3 have
actually followed — the same situation Phase 2 resolved for its own id-3 entry. Should build on:

- `IntentRecord` (Step 1), `DateLocationExtraction` (Step 2), and `VehicleDetermination` (Step 3) are
  now all independently queryable per-conversation; Step 4 reads all three the same tenant-scoped way
  (never raw text re-parsed) to compute what's still missing across the whole booking shape.
- Reuse the "AI proposes, deterministic domain logic verifies" split and the
  `*ResultSchema`-style pattern (always Zod-validate the final result) a fourth time.
- Do not build the real Event/Workflow Engine (journey state machine) here — still a distinct, larger
  phase per `MASTER-PLAN.md`, unchanged from Phase 2's note.

Do not start Phase 4 until asked.
