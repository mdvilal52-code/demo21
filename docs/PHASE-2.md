# Phase 2 — Extract Dates & Location (journey Step 2)

Status: **FROZEN**

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`, `docs/MASTER-PLAN.md`,
  `docs/DESIGN-SYSTEM.md` (no UI changes this phase, so nothing to apply from it).
- Read `docs/phases/PHASE-01.md` (previous phase).
- Inspected the repository; local PostgreSQL 16 + Redis 7 (same sandbox setup as Phase 1) restarted
  and confirmed reachable; ran the existing Phase 1 suite before changing anything.

## 2. Scope

Goal: journey Step 2 — **Extract Dates & Location** — end to end: take a Phase 1 conversation's
already-validated, intent-recognized message, propose pickup/return dates and pickup/dropoff
locations (AI side), and have deterministic domain logic verify the proposal (never trust it as-is)
before persisting and returning it.

Input: a Phase 1 `conversationId` (its latest `Message.content`). Output (`DateLocationExtraction`
row + API response): `pickupDate`, `returnDate`, `timezone`, `pickupLocation`, `dropoffLocation`,
`locationType`, `confidence`, `ambiguities`, `validationErrors` — exactly the fields specified for
this phase, plus `flags`/`modelMetadata` for consistency with Phase 1's `IntentResult` shape.

Out of scope (deferred): booking/pricing/vehicle steps, a real geocoding provider (still
`NOT_CONFIGURED`-equivalent — Phase 2 ships only the Dubai/UAE gazetteer), automatic worker-side
chaining of Step 1 → Step 2 (Phase 3's workflow engine formally sequences journey steps; wiring an
ad hoc chain into the Phase 1 worker now would be redone there).

## 3. Design decisions

- **Three services, one orchestrator — "AI proposes, deterministic domain logic verifies."**
  `DateExtractionService` and `LocationExtractionService` are the proposal layer (regex/gazetteer,
  same zero-hallucination discipline as Phase 1's `RuleBasedIntentEngine`). `TemporalValidationService`
  is the sole deterministic verifier and the only place a `DateLocationExtractionResult` is
  constructed — always through `dateLocationExtractionResultSchema.parse`.
  `DateLocationExtractionOrchestrator` wires them together.
- **Numeric-date ambiguity is structural, not locale-guessed.** `10/11/26` is ambiguous because
  _both_ a day-first and month-first reading are calendar-valid and produce different dates — that
  is computed (`asDayMonth`/`asMonthDay` validity + inequality check in `dateExtractionService.ts`),
  not hardcoded to "UAE uses DD/MM". A numeric date is only auto-resolved when just one reading is
  calendar-valid, or when both readings agree (e.g. `05/05/26`).
- **Impossible dates are verified by round-trip, not by a lookup table.** `isValidCalendarDate`
  (`packages/ai/step2/calendar.ts`) constructs the date via `Date.UTC` and checks the
  year/month/day round-trip, catching everything from `31 February` to `32/13/2026` without a
  days-per-month table to maintain.
- **Timezone conversion uses built-in `Intl`, not a new dependency.** `zonedTimeToUtc`
  (`packages/ai/step2/timezone.ts`) uses the standard "double conversion" technique against
  `Intl.DateTimeFormat`, verified DST-aware against `America/New_York` in tests even though Dubai
  itself has no DST — this is what makes the architecture actually ready for a future city that
  does observe DST, not just documentation saying so.
- **PAST_DATE compares calendar days in the resolved timezone, not raw instants.** A pickup
  requested for "today" must not be flagged past just because the request arrived after the
  service's fixed default pickup hour (10:00 local) later the same day — see
  `isBeforeCalendarDay` (`packages/ai/step2/calendarDay.ts`).
- **Two distinct "location didn't resolve" signals.** `UNRECOGNIZED_LOCATION_TEXT` (ambiguity:
  doesn't look like a real place) vs. `UNSUPPORTED_LOCATION` (validation error: a real, known city —
  e.g. London — recognized by name but outside the current service area). The latter is what makes
  "architecture must support future cities/countries" concrete: adding a city is adding a gazetteer
  entry (or a real provider), not teaching the system a new failure mode.
- **Default timezone when no location resolves: `Asia/Dubai`.** Phase 2 is a single-market MVP
  (Dubai/UAE only), so defaulting to the service's own operating timezone when the customer didn't
  name a location is an operational default, not a guess about a customer-specific fact — unlike a
  date or vehicle, which are never defaulted.
- **`dropoffLocation` is never defaulted to `pickupLocation`.** Even though most rentals return to
  the pickup point, inventing that assumption would contradict "ambiguous [...] must never be
  guessed" applied to locations; a booking-shaped message missing a dropoff simply has
  `dropoffLocation: null` for a later step to ask about.
- **Resilience primitives are generic, not geocoding-specific**, and live in `packages/security`
  (`resilience.ts`: `withTimeout`, `CircuitBreaker`, `RateLimiter`) since the brief groups
  timeouts/circuit-breakers/rate-limits under "SECURITY". They wrap even the zero-network
  `GazetteerLocationProvider` (`ResilientLocationProvider`) so the safety net is exercised by real
  tests now, not added the day a network-based geocoder replaces it.
- **New API endpoint, not a body-accepting one.** `POST /v1/enquiries/:conversationId/dates-location`
  takes no request body — it operates on the named conversation's already-stored, already-validated
  message, matching "INPUT: validated conversation + intent from Phase 1" literally rather than
  accepting fresh untrusted text at this layer.
- **`findLatestMessageForConversation` added instead of reusing `findConversationById`.** Phase 1's
  `findConversationById` doesn't order its `messages` include, so relying on it for "the latest
  message" would be relying on unspecified ordering. Added a new, explicitly-ordered, tenant-scoped
  repository function instead of changing Phase 1's existing one.
- **`fileParallelism: false` added to `apps/api`'s vitest config.** With a second integration test
  file now present (`temporal.integration.test.ts` alongside Phase 1's `app.integration.test.ts`),
  Vitest's default parallel file execution raced both suites against the same real Postgres tables
  (same class of issue already fixed for `packages/db` in Phase 1). Fixed the same way.

## 4. What was built

- `packages/domain/src/temporal.ts` — `LocationType`, `AmbiguityCode`, `ValidationErrorCode`,
  `normalizedLocationSchema`, `dateLocationExtractionResultSchema`.
- `packages/ai/src/step2/` — `calendar.ts`, `calendarDay.ts`, `timezone.ts`, `timezoneMismatch.ts`,
  `locationProvider.ts`, `gazetteer.ts` (+ `KNOWN_UNSERVICED_CITIES`), `gazetteerLocationProvider.ts`,
  `resilientLocationProvider.ts`, `locationExtractionService.ts`, `dateExtractionService.ts`,
  `temporalValidationService.ts`, `orchestrator.ts`.
- `packages/ai/src/shared/monthNames.ts` — month-name constants extracted from Phase 1's
  `dates.ts` (pure refactor, zero behavior change, re-verified against Phase 1's own tests) so
  Step 2 doesn't duplicate the table.
- `packages/security/src/resilience.ts` — `withTimeout`, `CircuitBreaker`, `RateLimiter`.
- `packages/db`: `DateLocationExtraction` model + `LocationType` enum (migration
  `20260916022258_add_date_location_extraction`), `dateLocationExtractionRepository.ts`,
  `findLatestMessageForConversation` added to `conversationRepository.ts`.
- `packages/contracts/src/temporal.ts` — request/response schemas for the new endpoint.
- `apps/api`: `services/dateLocationService.ts`, `routes/v1/temporal.ts`
  (`POST /v1/enquiries/:conversationId/dates-location`), `dateLocationOrchestrator` added to
  `AppContext`.
- `packages/testing/src/db.ts` — `date_location_extractions` added to the truncation list.

## 5. APIs

| Method | Path                                           | Purpose                                                                           |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/v1/enquiries/:conversationId/dates-location` | Run Step 2 against the conversation's latest message; persist + return the result |

Request/response schemas: `packages/contracts/src/temporal.ts`; live in the OpenAPI doc at `/docs`.

## 6. Database schema

`DateLocationExtraction` (`LocationType` enum: AIRPORT/HOTEL/LANDMARK/ADDRESS/CITY_AREA/UNKNOWN) —
see `packages/db/prisma/schema.prisma` and
`packages/db/prisma/migrations/20260916022258_add_date_location_extraction/`. Same conventions as
`IntentRecord`: tenant-scoped, stores the Zod-validated engine output verbatim, one row per
extraction run (append-only history, not upserted).

## 7. Security decisions

**Implemented and tested:**

- Provider abstraction (`LocationProvider`) — the only way `LocationExtractionService` talks to a
  location source; `GazetteerLocationProvider` makes zero network calls.
- SSRF protection — no external geocoding call exists in Phase 2, so none was needed; the interface
  doc and this file both direct any future implementer to `ssrfSafeFetch` rather than a raw `fetch`.
- Timeouts, circuit breaker, rate limiting — generic primitives (`packages/security/resilience.ts`),
  proven with dedicated unit tests and applied to the location provider seam
  (`resilientLocationProvider.security.test.ts`) even though the current provider doesn't need them.
- Prompt-injection detection — reused Phase 1's `sanitizeForProcessing`, no new implementation;
  proven at the orchestrator and API level with a real injection payload.
- Deterministic validation as a security boundary — `TemporalValidationService` is the only path to
  a persisted/returned result, so a bug in the (larger, regex-heavy) proposal layer can only ever
  produce an ambiguity/error, never a silently-wrong committed booking date.

**Explicitly deferred (documented, not silently skipped):**

- A real geocoding provider (still Dubai/UAE gazetteer only) — Phase 4/5+ scope per `MASTER-PLAN.md`.
- Database-level Row Level Security — still application-level only, unchanged from Phase 1.
- Automatic worker-side Step 1 → Step 2 chaining — Phase 3's workflow engine formally owns journey
  sequencing; this phase exposes Step 2 as a directly callable, independently testable capability.

## 8. Test results

All commands run against real local PostgreSQL 16 + Redis 7 (same sandbox as Phase 1; Docker
daemon still unavailable here, `docker-compose.yml` unchanged and correct for normal use).

| Gate        | Command                 | Result                                             |
| ----------- | ----------------------- | -------------------------------------------------- |
| Typecheck   | `pnpm typecheck`        | ✅ 11/11 packages                                  |
| Lint        | `pnpm lint`             | ✅ 0 errors, 0 warnings                            |
| Format      | `pnpm format:check`     | ✅ clean                                           |
| Unit        | `pnpm test:unit`        | ✅ 185 tests (was 91 in Phase 1 — 94 new)          |
| Integration | `pnpm test:integration` | ✅ 32 tests (was 21 — 11 new)                      |
| Security    | `pnpm test:security`    | ✅ 29 tests (was 21 — 8 new)                       |
| E2E         | `pnpm test:e2e`         | ✅ 4 tests, unchanged from Phase 1 (no UI touched) |
| Build       | `pnpm build`            | ✅ every package + Next.js production build        |

**Total: 250 automated tests, all passing** — the full Phase 1 suite re-run and green (regression
requirement), plus Phase 2's new coverage.

Every explicitly required test case passes, most directly in
`packages/ai/src/step2/orchestrator.test.ts` (end-to-end through the real orchestrator) and again
through the live HTTP API in `apps/api/src/temporal.integration.test.ts` /
`temporal.security.test.ts`:

| Case                          | Where              | Result                                                                                   |
| ----------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `15 Oct`                      | orchestrator + API | resolves cleanly                                                                         |
| `15-19 Oct`                   | orchestrator + API | pickup + return resolved                                                                 |
| `tomorrow`                    | orchestrator       | resolves relative to reference date                                                      |
| `next Friday`                 | orchestrator       | resolves to a concrete future date                                                       |
| ambiguous `10/11/26`          | orchestrator + API | `AMBIGUOUS_NUMERIC_DATE`, never guessed                                                  |
| invalid date (`31 February`)  | orchestrator + API | `IMPOSSIBLE_DATE`, never rounded forward                                                 |
| past date (`1 Jan 2020`)      | orchestrator + API | extracted, then `PAST_DATE`                                                              |
| return before pickup          | orchestrator + API | `RETURN_BEFORE_OR_EQUAL_PICKUP`                                                          |
| timezone mismatch (`3pm EST`) | orchestrator + API | `TIMEZONE_MISMATCH`                                                                      |
| Dubai                         | orchestrator + API | resolves `Asia/Dubai`, `CITY_AREA`                                                       |
| unknown location              | orchestrator + API | `UNRECOGNIZED_LOCATION_TEXT` (or `UNSUPPORTED_LOCATION` for a known-but-unserviced city) |
| malicious prompt injection    | orchestrator + API | `flags.promptInjectionDetected`, no fabricated date                                      |

## 9. Known limitations

- **Numeric-date and location-phrase regexes are English-only**, matching Phase 1's documented
  lexicon limitation — non-English phrasing correctly falls through to an ambiguity/absence rather
  than a wrong guess, but isn't specifically resolved yet.
- **Timezone-abbreviation map is a fixed, small, documented simplification**
  (`packages/ai/src/step2/timezoneMismatch.ts`) — e.g. "IST" is treated as India Standard Time, not
  Israel; a real geocoding/timezone provider would resolve this correctly.
- **Location phrase detector is heuristic** (preposition + capitalized-word pattern), not a real
  NER model — sufficient to distinguish "a location was mentioned" from "nothing was mentioned" for
  the ambiguity/unsupported signals, not a general-purpose place-name extractor.
- **`KNOWN_UNSERVICED_CITIES` is a short, illustrative list**, not a real out-of-area registry —
  intentionally small; extending real coverage is Phase 4/5+ scope.
- **No Docker daemon in this dev sandbox** (same as Phase 1) — `docker-compose.yml` unaffected and
  correct for normal local/CI use; local Postgres/Redis binaries were used directly for testing here.

## 10. Files created

- `packages/domain/src/temporal.ts`, `packages/domain/src/temporal.test.ts`
- `packages/ai/src/shared/monthNames.ts`
- `packages/ai/src/step2/*.ts` and matching `*.test.ts` / `*.security.test.ts` (calendar, calendarDay,
  timezone, timezoneMismatch, locationProvider, gazetteer, gazetteerLocationProvider,
  resilientLocationProvider, locationExtractionService, dateExtractionService,
  temporalValidationService, orchestrator)
- `packages/security/src/resilience.ts`, `packages/security/src/resilience.test.ts`
- `packages/db/prisma/migrations/20260916022258_add_date_location_extraction/migration.sql`
- `packages/db/src/repositories/dateLocationExtractionRepository.ts` (+ `.test.ts`)
- `packages/contracts/src/temporal.ts` (+ `.test.ts`)
- `apps/api/src/services/dateLocationService.ts` (+ `.test.ts`)
- `apps/api/src/routes/v1/temporal.ts`
- `apps/api/src/temporal.integration.test.ts`, `apps/api/src/temporal.security.test.ts`
- `apps/api/vitest.config.ts`
- `docs/PHASE-2.md` (this file)

## 11. Files modified

- `packages/ai/src/dates.ts` — pure refactor: month-name constants now imported from
  `shared/monthNames.ts` instead of declared locally; behavior unchanged, Phase 1 tests re-verified.
- `packages/ai/src/index.ts`, `packages/domain/src/index.ts`, `packages/security/src/index.ts`,
  `packages/contracts/src/index.ts`, `packages/db/src/index.ts` — new exports added.
- `packages/ai/package.json` — added `@ai-concierge/security` dependency (resilience primitives).
- `packages/db/prisma/schema.prisma` — added `DateLocationExtraction` model, `LocationType` enum,
  relations from `Tenant`/`Message`.
- `packages/db/src/repositories/conversationRepository.ts` — added
  `findLatestMessageForConversation` (additive; existing functions unchanged).
- `packages/testing/src/db.ts` — `date_location_extractions` added to `TABLES`.
- `apps/api/src/context.ts`, `apps/api/src/server.ts`, `apps/api/src/test/buildTestApp.ts`,
  `apps/api/src/app.ts` — `dateLocationOrchestrator` wired into `AppContext`; new route registered.
- `docs/ARCHITECTURE.md`, `docs/PHASE-CONTRACTS.json` — updated for Phase 2.

## 12. Migration status

One new migration applied and verified on both dev and test databases:
`20260916022258_add_date_location_extraction` (forward migration path exercised via
`prisma migrate dev` / `prisma migrate deploy`, same convention as Phase 1's initial migration).

## 13. Phase 3 contract (proposed inputs for the next phase)

Per `MASTER-PLAN.md` §4, journey Step 3 is **Determine Vehicle**. Should build on:

- `DateLocationExtraction` now exists as the Step 2 output; Step 3 reads it the same way Step 2
  read Phase 1's `IntentRecord` (tenant-scoped repository lookup, never raw text re-parsed).
- Reuse the "AI proposes, deterministic domain logic verifies" split and the
  `dateLocationExtractionResultSchema`-style pattern (always Zod-validate the final result).
- Reuse `packages/security/resilience.ts` for any new external provider seam (vehicle
  availability/pricing lookups), the same way Step 2 wrapped its location provider.
- `KNOWN_UNSERVICED_CITIES`/gazetteer pattern generalizes to a fleet/availability gazetteer if
  Step 3 needs a similar "known but not offered" distinction.
- Do not build the real Event/Workflow Engine (journey state machine) here — that is a distinct,
  larger phase per `MASTER-PLAN.md` (originally scoped as Phase 3 in the 10-phase breakdown) and
  should be done deliberately, not implicitly through step-chaining logic added ad hoc.

Do not start Phase 3 until asked.
