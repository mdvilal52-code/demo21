# Phase 13 — Alternatives (journey Step 7)

Status: **FROZEN**

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`, `docs/MASTER-PLAN.md`,
  `docs/DESIGN-SYSTEM.md` (this phase touches no UI, so read for context only).
- Read `docs/PHASE-12.md` (previous phase doc — journey Step 6, Availability), which itself names
  this exact step as its own deliberate "not wired in yet" seam (see §2 "Out of scope" and §9
  "Known limitations" there: `AvailabilityProvider`/`AvailabilityCheckOrchestrator` were "built and
  tested as the seam journey Step 7 (Alternatives) will need").
- Inspected the repository; local PostgreSQL 16 + Redis 7 started (no Docker daemon in this
  sandbox, same as every prior phase) and confirmed reachable; ran the existing suite before
  changing anything — baseline **521 unit + 189 integration + 72 security tests, all green**
  (exactly matching `docs/PHASE-12.md`'s own final numbers — confirms nothing drifted between
  phases).
- Reviewed `MASTER-PLAN.md` §1 (target architecture) and §6 (cross-cutting standards) before and
  after implementation (architecture review, §9 below).

**Phase-numbering reconciliation (read this before anything else in this doc — same discipline
`docs/PHASE-12.md` §1 used).** The task named this "PHASE 7" with a spec that is, word for word,
`MASTER-PLAN.md` §4 journey Step 07 ("Alternatives", `OFFERING_ALTERNATIVES`, "if unavailable:
nearest dates / similar class / upgrade options from real availability"): rank by availability →
customer constraints → category → luxury tier → price → preference, never recommend unavailable
inventory as available, human decision remains available. `PHASE-CONTRACTS.json`'s literal id-7
entry is "Admin Dashboard (Web)" — an unrelated, pre-journey-numbering placeholder with zero overlap
with the request, `dependsOn: [6]` (id-6 "Security Engine & Zero Trust", still `PENDING`).

This is the exact same shape of mismatch `docs/PHASE-12.md` §1 already resolved for "journey Step 6"
against contract id-6, and `docs/PHASE-11.md` resolved for journey Step 5 against id-11's precedent.
Two independent pieces of evidence, not a guess:

1. `PHASE-CONTRACTS.json`'s own `phaseNumbering` note (as of this phase's start) already documents
   the resolution mechanism from the two prior reconciliations: append the new journey-step phase at
   the **next free integer id** rather than renumbering ids 1-10 (id 11 = journey Step 5 Eligibility,
   id 12 = journey Step 6 Availability, both `dependsOn` reflecting real functional dependency, not
   journey order — id 12 depends on `[4]`, not `[11]`, "since Availability does not functionally
   depend on Eligibility despite coming after it in journey order").
2. The codebase already forward-references this exact feature by name: `docs/PHASE-12.md` §3 and §9
   both cite "journey Step 7 (Alternatives)" as the intended caller of the very seams (
   `AvailabilityProvider`, `AvailabilityCheckOrchestrator`) that were built untested-in-production for
   that reason, and `packages/ai/src/step6/orchestrator.ts`'s own module doc says the same.

The user confirmed this reading directly mid-session (pointing at the newly landed journey Step 5/6
work — id 11/id 12 — as the resolution once the ambiguity was raised) rather than the literal
contract id-7. Following the established id-11/id-12 precedent exactly: this phase is appended as
**id 13**, `dependsOn: [12]` — Step 7 needs Steps 1-4's resolved vehicle/dates (already covered
transitively through id 12's own chain) and, explicitly, Step 6's real availability seam (`"from
real availability"` in the spec) — not id 11 (Eligibility), which Alternatives has no functional
need for (ranking alternatives is about vehicle/availability/price matching, not customer
eligibility).

## 2. Scope

Goal: given a conversation whose Step 3 vehicle and Step 2 dates/location are already resolved,
deterministically rank real, currently-available alternative vehicles and explain why — never a
fabricated availability claim, never an AI-made ranking decision, never a placed hold.

**In scope:**

- One HTTP endpoint: `POST /v1/enquiries/:conversationId/alternatives`, reading whatever Steps 1-3
  already resolved (never raw text, never a request body) — same convention as Steps 2-6.
- A deterministic ranking ladder over exactly the six criteria the spec listed, in that order:
  availability (filter) → customer constraints (filter) → vehicle category (score) → luxury tier
  (score) → price (score) → preference (score/tiebreak).
- Real candidate generation reusing Step 3's `VehicleCatalogProvider` (`findAlternatives`,
  category-scoped-first-then-widen) — "database is authoritative, never invent inventory."
- Real, live availability confirmation per candidate reusing Step 6's `AvailabilityProvider` (the
  non-committal preview seam Phase 6 built specifically for this step) — never
  `ReservationLockService.placeHold`; this step must never reserve capacity against a candidate the
  customer hasn't chosen.
- Deterministic, template-based `reason` text per candidate ("AI can explain recommendations" — see
  §3) — zero AI/LLM calls anywhere in the ranking path.
- Persisted, audited history of every run (`AlternativeRecommendation`, append-only, same convention
  as `VehicleDetermination`/`AvailabilityCheck`).
- Required test scenarios: no alternative; one alternative; many alternatives; same-category
  alternatives; price conflict; availability conflict; prompt injection; biased recommendation test
  (§8).

**Out of scope (deferred, not started):**

- Wiring this into `runFullEnquiryPipeline`/the WhatsApp auto-pipeline — same posture Phases 5-6 took
  for their own endpoints; left to the user to decide whether/when to chain it in, and whether the
  trigger condition should be "Step 6 said UNAVAILABLE" or something else.
- A real per-date-range "customer requirements" input (seat count, feature needs, etc.) — Steps 1-4
  only ever persist pickup/return date, pickup location, and the resolved vehicle reference
  (`collectedBookingInfoSchema`); there is no other structured requirement field to filter on today.
  This phase uses the requested vehicle's own seats/luggage as the only grounded proxy — see §3.
- Journey Step 8 (Quote/pricing engine) — `priceDifference` here is a Step-3-level "budget hint"
  comparison (`Vehicle.pricingProfile.dailyRate`), not the real duration-tier/extras/deposit/VAT
  pricing engine that Step 8 owns.
- Location-based candidate filtering — the fleet catalog has no branch/location field at all yet
  (single-tenant-wide inventory); Step 2's resolved pickup location is not currently used to narrow
  candidates. Documented, not silently faked.
- `PHASE-CONTRACTS.json` id-7 "Admin Dashboard (Web)" — unrelated, unchanged, still fully `PENDING`
  (see §1).
- `PHASE-CONTRACTS.json` id-6 "Security Engine & Zero Trust" — unrelated, unchanged, still fully
  `PENDING`.

## 3. Design decisions

- **The ladder is a filter-then-sort cascade, mirroring Step 5's rule-cascade shape.** Stage 1
  (availability) and Stage 2 (customer constraints) are hard filters — a candidate that fails either
  is dropped entirely, never merely ranked last. Stages 3-6 (category, luxury tier, price,
  preference) are a strict comparator applied in that exact priority order to the survivors. This
  reads "Ranking: 1 availability, 2 customer constraints, 3 vehicle category, 4 luxury tier, 5
  price, 6 preference" literally, and matches this repo's own `AGENTS.md`-style "decision ladder"
  idiom already used for Step 5's rule chain.
- **"Never recommend unavailable inventory as available" is enforced by construction, not by
  convention.** Stage 1 calls the real `AvailabilityProvider` (Step 6's preview seam) for every
  candidate and keeps only those confirmed `AVAILABLE` for the exact requested dates _at ranking
  time_. A vehicle that merely looks available in the static catalog
  (`Vehicle.availabilityStatus`) but is actually held/booked for these specific dates is exactly the
  gap this closes — proven end to end in the "availability conflict" test (§8), which places a real
  hold via Step 6's own endpoint from a second conversation and confirms the held vehicle never
  surfaces as a recommendation from the first.
- **Customer constraints proxy: the requested vehicle's own capacity.** The richest structured
  "requirement" Steps 1-4 persist today is the resolved vehicle itself, so Stage 2 requires a
  qualifying alternative to seat/carry at least as much as what the customer originally asked for
  (`seats >= requested.seats && luggage >= requested.luggage`). This is honest and grounded — not a
  fabricated requirement — but it is a real limitation (§9): a customer's actual spoken requirements
  (e.g. "needs a car seat", "needs 7 seats") aren't captured as structured data anywhere yet.
- **Reuses two existing seams instead of inventing new ones.** `VehicleCatalogProvider` (Step 3) for
  candidates and `AvailabilityProvider` (Step 6) for live availability — both already real,
  DB-backed, and tested. No new provider abstraction, no new external integration surface.
- **Extracted `findAlternativesWithFallback` (shared with Step 3) — found by this phase's own
  `/code-review`, not assumed correct.** The first version duplicated Step 3's
  category-scoped-then-widen-to-general-fleet fallback logic inline in the new orchestrator instead
  of reusing it, which the review flagged as a real reuse/simplification gap (a future change to the
  widening policy in one copy would silently drift from the other). Fixed by extracting the shared
  policy into `packages/ai/src/step3/vehicleCatalogProvider.ts` (the file that already owns the
  `VehicleCatalogProvider` interface) and having both `VehicleCatalogService.resolve` (Step 3) and
  `AlternativeRecommendationOrchestrator.recommend` (this phase) call it — a pure extract-method
  refactor, verified behavior-preserving by re-running Step 3's own existing test suite unchanged
  (§8).
- **Price ranks by absolute distance from the requested rate, not "cheaper wins" or "pricier
  wins" — the "biased recommendation" requirement taken literally.** A candidate AED 100 below the
  requested rate and one AED 100 above tie on this stage; ranking by signed difference (or by raw
  price) would let the engine quietly favor whichever direction happened to dominate the candidate
  set — exactly the "recommend the pricier upsell under guise of best match" failure mode called
  out in the spec. Proven directly: two candidates equidistant in price (one cheaper, one pricier)
  produce a tie broken only by the documented, content-neutral tiebreak (brand match, then vehicle
  id) — never a hidden preference for the more expensive one (§8).
- **A currency mismatch is an honest `null`, never a guessed or converted figure ("price
  conflict").** `priceDifference`/`currency` are only populated when the candidate quotes the same
  ISO 4217 currency as the requested vehicle; a cross-currency candidate is still considered and can
  still win on category/tier/brand, but its price comparison is truthfully reported as unavailable
  rather than fabricated via an invented exchange rate.
- **"Preference" (Stage 6) = same make as requested.** No structured customer-preference signal
  exists in this codebase yet (no explicit "I prefer German brands" style input anywhere); the only
  real, non-fabricated preference proxy available is that a customer who named a specific make
  implicitly leans toward that make when the exact model isn't available. Documented as a design
  choice, not presented as a richer signal than it is.
- **"AI can explain recommendations" via a deterministic, template-based `reasonBuilder` — the same
  "AI may explain, must never decide" split Step 5's `buildEligibilityReason` already established.**
  Zero AI/LLM calls anywhere in the ranking or explanation path; `reason` is formatted directly from
  the ranking engine's own structured output, never a live model call over untrusted output. This
  keeps a customer-facing recommendation surface free of the hallucination risk a real LLM call
  would introduce, while still satisfying "AI can explain" in the same sense this repo already uses
  that phrase elsewhere.
- **"Human decision remains available" — this step never places a hold.** Only
  `AvailabilityProvider.checkAvailability` (the non-committal preview) is called, never
  `ReservationLockService.placeHold`. A human/customer must still choose an alternative and go
  through Step 6's own endpoint to actually reserve it — proven directly (§8: "never places a hold
  against any candidate").
- **`findLatestAlternativeRecommendationForMessage` orders by `createdAt` then `id` — found by this
  phase's own `/code-review`.** `createdAt` alone is only millisecond precision, so two runs for the
  same message in the same millisecond would resolve non-deterministically under Postgres's
  no-tiebreak-guarantee `ORDER BY ... LIMIT 1` — a latent test flake as well as a real gap for any
  future "latest" consumer. Fixed with an `id` tiebreak for query determinism; this makes the query
  _repeatable_, not truly chronological (ids are random UUIDs, not time-ordered) — the same
  limitation every other `findLatest*` repository in this codebase already has (`VehicleDetermination`,
  `AvailabilityCheck`, etc., none of which have a tiebreak either). Left those pre-existing,
  unrelated files untouched — fixing a repo-wide pattern is outside this phase's scope; noted here
  for visibility (§9).
- **A stray local `dump.rdb` (Redis's own background-save snapshot from this session's local Redis
  instance) was never committed — found by this phase's own `/code-review`.** Removed and added
  `dump.rdb` to `.gitignore` so a future local session can't accidentally commit one either.

## 4. What was built

- `packages/domain/src/alternatives.ts` — `AlternativeRecommendationStatus`,
  `AlternativesErrorCode`, `alternativeCandidateSchema`, `recommendAlternativesResultSchema`.
- `packages/ai/src/step7/` — `types.ts` (`EvaluatedCandidate`, `RankingStageResult`,
  `RankedCandidate`, `RankAlternativesResult`), `rankingEngine.ts` (pure `rankAlternatives` — the
  six-stage ladder), `reasonBuilder.ts` (`buildAlternativeReason`, deterministic template text),
  `orchestrator.ts` (`AlternativeRecommendationOrchestrator`), `test/fixtures.ts` (`makeVehicle`) +
  matching `.test.ts` for each.
- `packages/ai/src/step3/vehicleCatalogProvider.ts` — added `findAlternativesWithFallback` (shared
  with `vehicleCatalogService.ts`, see §3).
- `packages/db/prisma/schema.prisma` — `AlternativeRecommendationStatus` enum,
  `AlternativeRecommendation` model + relations on `Tenant`/`Message`/`Vehicle`; migration
  `20260923221714_add_alternative_recommendations`.
- `packages/db/src/repositories/alternativeRecommendationRepository.ts` —
  `createAlternativeRecommendation`, `findLatestAlternativeRecommendationForMessage` + tests.
- `apps/api/src/services/alternativesService.ts` — `recommendAlternatives`, the HTTP-facing
  service.
- `apps/api/src/routes/v1/alternatives.ts` — `POST /v1/enquiries/:conversationId/alternatives`.
- `apps/api/src/context.ts`, `server.ts`, `test/buildTestApp.ts` — `alternativeRecommendationOrchestrator`
  wired into `AppContext`, constructed from the existing `PrismaVehicleCatalogProvider` and a new
  `PrismaAvailabilityProvider` instance (mirrors how `reservationLockService` is already wired).
- `packages/contracts/src/alternatives.ts` — `recommendAlternativesParamsSchema` /
  `recommendAlternativesResponseSchema`.
- `packages/testing/src/db.ts` — `alternative_recommendations` added to the truncation list.
- `.gitignore` — `dump.rdb` (see §3).
- `docs/PHASE-13.md` (this file), `docs/PHASE-CONTRACTS.json` (id 13, see §1).

No changes to Steps 1-6's own logic, the WhatsApp channel, or the auto-pipeline — the one
behavior-preserving refactor (§3, `findAlternativesWithFallback`) is verified against Step 3's own
existing, unchanged test suite.

## 5. APIs

| Method | Path                                         | Purpose                                                                             |
| ------ | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| POST   | `/v1/enquiries/:conversationId/alternatives` | Ranks real, currently-available alternatives to the conversation's resolved vehicle |

Input is the conversation id only (no request body) — matching Steps 2-6's convention. 400
`VEHICLE_NOT_RESOLVED`/`DATES_NOT_RESOLVED` if Step 3/Step 2 haven't run yet; 404 for an
unknown/cross-tenant conversation. Request/response schemas: `packages/contracts/src/alternatives.ts`;
live in the OpenAPI doc at `/docs`.

## 6. Database schema

New migration `packages/db/prisma/migrations/20260923221714_add_alternative_recommendations/`:

- `AlternativeRecommendation` (`alternative_recommendations`) — append-only recommendation-run
  history, same convention as `VehicleDetermination`/`AvailabilityCheck`. `primary`/`secondary` store
  the exact `AlternativeCandidate` JSON the customer was shown.
- New enum `AlternativeRecommendationStatus`.
- Relations added to `Tenant`, `Message`, `Vehicle`.

Purely additive — no existing column/table changed. Verified via `prisma migrate dev` against a
real local dev database, then `prisma migrate deploy` against the test database; migration SQL
reviewed directly (only `CREATE TYPE`/`CREATE TABLE`/`CREATE INDEX`/`ADD CONSTRAINT` statements).

## 7. Security decisions

**Implemented and tested:**

- **Never a fake availability claim.** Every candidate's status comes from a live call to the same
  `AvailabilityProvider` Step 6 built and tests against real inventory/hold state — never the static
  catalog flag alone, never a guess. A provider failure (`UNKNOWN`) simply excludes that candidate
  rather than fabricating `AVAILABLE`.
- **No untrusted raw input reaches this step.** The endpoint takes no body; its only inputs are
  already-Zod-validated Step 2/3 persisted results and the path's `conversationId` (UUID-validated).
  Proven with a dedicated prompt-injection test at both the integration layer (identical ranking
  outcome with vs. without an injected instruction in the original message) and the security layer.
- **Tenant isolation** — candidate generation, availability checks, and the persisted history are
  all tenant-scoped through the same repositories/providers Steps 3 and 6 already isolate; proven
  with a dedicated cross-tenant test (no candidate from another tenant's identically-shaped fleet
  ever surfaces).
- **Never leaks internal detail.** 404/400 responses carry only a stable `AppError` code +
  `details.code`, never a stack trace, SQL fragment, or driver message — checked explicitly by regex
  in the security tests.
- **Audit event on every run** — `alternatives.recommended`, written in the same transaction as the
  persisted `AlternativeRecommendation` row.
- **No new external integration surface** — this phase adds zero new outbound network calls; it only
  composes two already-audited, already-tested internal seams.

**Explicitly deferred (documented, not silently skipped):**

- Database-level Row Level Security — unchanged from every prior phase; still
  `PHASE-CONTRACTS.json` id-6 scope (this phase's real numbering identity is id 13; id 6's own
  content is unrelated, see §1).
- No idempotency key on this endpoint — deliberate, not an oversight: unlike Step 6's `placeHold`
  (which claims scarce, shared capacity and must not double-consume it), this step only reads and
  appends an audit trail row; a repeated call is harmless and simply logs a fresh snapshot, the same
  posture Steps 2-4's own read-and-log endpoints already take (none of them carry an idempotency key
  either — only the resource-claiming Step 6 endpoint does).

## 8. Test results

All commands run against real local PostgreSQL 16 + Redis 7 (no Docker daemon in this sandbox, same
as every prior phase).

| Gate                | Command                              | Result                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typecheck           | `pnpm typecheck`                     | ✅ every package + app                                                                                                                                                                                                                                                                                                   |
| Lint                | `pnpm lint`                          | ✅ 0 errors, 0 warnings                                                                                                                                                                                                                                                                                                  |
| Format              | `pnpm format:check`                  | ✅ clean                                                                                                                                                                                                                                                                                                                 |
| Unit                | `pnpm test:unit`                     | ✅ 541 tests (+20 from baseline)                                                                                                                                                                                                                                                                                         |
| Integration         | `pnpm test:integration`              | ✅ 205 tests (+16 from baseline)                                                                                                                                                                                                                                                                                         |
| Security            | `pnpm test:security`                 | ✅ 79 tests (+7 from baseline)                                                                                                                                                                                                                                                                                           |
| E2E                 | `pnpm test:e2e`                      | ✅ 4 tests, unchanged (no UI touched)                                                                                                                                                                                                                                                                                    |
| Build               | `pnpm build`                         | ✅ every package + Next.js production build                                                                                                                                                                                                                                                                              |
| Code review         | `/code-review` (high)                | ✅ 3 findings — 1 fixed as a local determinism improvement + documented pre-existing sibling gap (`id`-tiebreak on "latest" reads), 1 duplication eliminated (shared `findAlternativesWithFallback`, verified against Step 3's own unchanged tests), 1 stray local artifact removed + `.gitignore` hardened (`dump.rdb`) |
| Architecture review | checklist vs `MASTER-PLAN.md` §1, §6 | ✅ matches target layering (packages/ai pure, apps/api the composition root); Zod at every boundary, `AppError`, audit-on-mutation, DI via constructor injection all present; money-as-float and no-outbox-table are pre-existing Phase 3/architecture-wide gaps, not introduced or worsened here (§9)                   |
| Regression          | `pnpm test` (final commit)           | ✅ full Phase 1-6 + this phase, all green                                                                                                                                                                                                                                                                                |

**Total: 829 automated tests, all passing** (541 unit + 205 integration + 79 security + 4 e2e) — the
whole repository's final state.

Every explicitly required test case, mapped to where it's proven:

| Case                       | How it's proven                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No alternative             | `rankingEngine.test.ts` (pure) + `alternatives.integration.test.ts` "returns NO_ALTERNATIVES when no other vehicle exists in the fleet" (real DB, only the requested vehicle seeded)                                                               |
| One alternative            | `rankingEngine.test.ts` + `alternatives.integration.test.ts` "returns exactly one candidate when only one qualifies" — `secondary` is `null`                                                                                                       |
| Many alternatives          | `rankingEngine.test.ts` "many alternatives" + `alternatives.integration.test.ts` — 3 real candidates seeded, `consideredCount` reflects all, top 2 returned as primary/secondary                                                                   |
| Same-category alternatives | `rankingEngine.test.ts` "ranks a same-category candidate above an equally-priced different-category one" (pure, mixed categories) + `alternatives.integration.test.ts` (proves the real candidate-provider's own category-scoped-first policy, §3) |
| Price conflict             | `rankingEngine.test.ts` + `reasonBuilder.test.ts` + `alternatives.integration.test.ts` "honestly reports no price comparison for a different-currency candidate" — `priceDifference`/`currency` both `null`, candidate still recommendable         |
| Availability conflict      | `alternatives.integration.test.ts` "never recommends a vehicle that looks catalog-available but is actually held for these dates" — a _real_ hold placed via Step 6's own endpoint from a second conversation                                      |
| Prompt injection           | `alternatives.integration.test.ts` + `alternatives.security.test.ts` — an injected instruction in the original customer message produces an identical ranking outcome to a clean control run                                                       |
| Biased recommendation test | `rankingEngine.test.ts` "does not exhibit an upsell bias" + "treats equidistant cheaper/pricier candidates as a true tie" + `alternatives.integration.test.ts` "does not favor the pricier candidate when a cheaper one is an equally good match"  |

Plus: tenant isolation (integration + security), 400 `VEHICLE_NOT_RESOLVED`/`DATES_NOT_RESOLVED`, 404
unknown conversation, persisted `AlternativeRecommendation` + audit event, never places a hold
("human decision remains available"), SQL-injection-shaped message inertness, malformed
conversation id, no internal-detail leakage — all at the real HTTP layer against a real database.

## 9. Known limitations

- **Not wired into the WhatsApp auto-pipeline or any other channel** — ships as a standalone
  endpoint, same posture Phases 5-6 took for their own endpoints. Left to the user to decide the
  trigger condition (e.g. call this automatically whenever Step 6 returns `UNAVAILABLE`/`MAINTENANCE`)
  and whether/when to chain it into `runFullEnquiryPipeline`.
- **"Customer constraints" is a narrow proxy (requested vehicle's own seats/luggage), not a real
  requirements-capture feature** — see §3. A customer's actual spoken requirements (child seat, fuel
  type, accessibility needs, etc.) aren't structured data anywhere in this codebase yet.
- **No location/branch-based candidate filtering** — the fleet catalog has no location field; every
  candidate is considered regardless of pickup location. Not a fabricated answer (the catalog
  genuinely has no such dimension today), just an honest scope gap.
- **Money is a JS `number` (float), not integer minor units** — `MASTER-PLAN.md` §6 specifies "money
  in integer minor units (fils)... never floats"; `Vehicle.pricingProfile.dailyRate` has been a float
  since Phase 3 (frozen), and this phase only consumes that existing field — not introduced or
  worsened here, but inherited and worth flagging for whoever eventually builds the real Step 8
  pricing engine.
- **`findLatestAlternativeRecommendationForMessage`'s `id` tiebreak makes reads repeatable, not
  truly chronological** — see §3. Shared by every other `findLatest*` repository in this codebase;
  not uniquely fixed here.
- **Candidate set is capped at 5 per run** (matches Step 3's own `FALLBACK_ALTERNATIVES_LIMIT`
  precedent) — `consideredCount` always reflects what was actually evaluated, never a larger implied
  total.
- **No Docker daemon in this dev sandbox** (same as every prior phase) — `docker-compose.yml`
  unaffected.
- Every limitation Phases 1-6 already listed and didn't explicitly note as fixed here is still open
  (no database-level RLS, keyword-based English-only intent classification, no per-sender rate limit
  beyond the API-wide one, `MetaWhatsAppProvider`/`ExternalFleetApiProvider` untested against their
  real external counterparts, no Docker daemon in this sandbox).

## 10. Files created

- `packages/domain/src/alternatives.ts`
- `packages/ai/src/step7/{types,rankingEngine,reasonBuilder,orchestrator}.ts` + matching `.test.ts` + `test/fixtures.ts`
- `packages/db/prisma/migrations/20260923221714_add_alternative_recommendations/`
- `packages/db/src/repositories/alternativeRecommendationRepository.ts` + `.test.ts`
- `apps/api/src/services/alternativesService.ts`
- `apps/api/src/routes/v1/alternatives.ts`
- `apps/api/src/alternatives.integration.test.ts`, `apps/api/src/alternatives.security.test.ts`
- `packages/contracts/src/alternatives.ts`
- `docs/PHASE-13.md` (this file)

## 11. Files modified

- `packages/db/prisma/schema.prisma` (+ `AlternativeRecommendation` model/enum, relations on
  `Tenant`/`Message`/`Vehicle`)
- `packages/ai/src/step3/vehicleCatalogProvider.ts` (+ `findAlternativesWithFallback`),
  `vehicleCatalogService.ts` (refactored to call it — behavior-preserving, §3)
- `packages/db/src/index.ts`, `packages/ai/src/index.ts`, `packages/domain/src/index.ts`,
  `packages/contracts/src/index.ts` — new exports
- `packages/testing/src/db.ts` — `alternative_recommendations` added to `truncateAllTables`
- `apps/api/src/context.ts`, `server.ts`, `app.ts`, `test/buildTestApp.ts` — orchestrator wired
  through, route registered
- `.gitignore` — `dump.rdb` (§3)
- `docs/PHASE-CONTRACTS.json` — updated for this phase (id 13, see §1)

No working Phase 1-6 functionality was changed; `pnpm test` (full regression) re-run green on the
final commit.

## 12. Migration status

One additive migration this phase (see §6). No down-migration needed — every change is a new
table/enum; reverting the code is safe without reverting the schema (an unused table, not a broken
one).

## 13. Next steps (proposed, not started)

Per `docs/PHASE-12.md` §13 and `MASTER-PLAN.md` §4, several threads remain open, none started here:

1. Wiring Steps 5-7 (Eligibility, Availability, Alternatives) into the WhatsApp auto-pipeline
   (`runFullEnquiryPipeline`), including deciding when Step 7 should fire automatically (e.g. Step 6
   returning `UNAVAILABLE`/`MAINTENANCE`) versus only on explicit request.
2. Journey Step 8 (Quote — the real pricing engine: duration tiers, extras, deposit, VAT).
3. `PHASE-CONTRACTS.json` id-6 "Security Engine & Zero Trust" and id-7 "Admin Dashboard (Web)" —
   unrelated, unchanged, still fully `PENDING` (see §1).
4. The rest of `PHASE-CONTRACTS.json` id-5's original scope (Web chat/Email adapters, documents,
   payments, CRM, delivery/return) — still `PENDING`, untouched.

Do not start any of these until asked.
