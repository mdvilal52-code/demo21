# Phase 4 — Ask Missing Information (journey Step 4)

Status: **FROZEN**

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`, `docs/MASTER-PLAN.md`
  (no UI changes this phase, so `docs/DESIGN-SYSTEM.md` has nothing to apply).
- Read `docs/PHASE-3.md` (previous phase) and its §13 forward contract for Phase 4.
- Inspected the repository; local PostgreSQL 16 + Redis 7 confirmed reachable after a session
  restart; ran the existing Phase 1-3 suite before changing anything (350-test baseline green).

## 2. Scope

Goal: journey Step 4 — **Ask missing information** — end to end: given a conversation, read
whatever Steps 1-3 have already resolved and verified (never raw text re-parsed at this layer) and
deterministically decide what's still needed before the booking can proceed, generating one
combined clarification question when something is missing.

Input: a conversation (its `createdAt`, and whatever `IntentRecord`/`DateLocationExtraction`/
`VehicleDetermination` rows exist for its latest message — any or all may not exist yet, since
Steps 2-3 are independently callable and may not have run). Output (`MissingInfoCheck` row + API
response): `status` (`COMPLETE`/`NEEDS_INFO`/`EXPIRED`/`NOT_APPLICABLE`), `collected` (a read-through
summary of pickup/return date, pickup/dropoff location, and vehicle), `missingFields` (each with a
`reason`: `NOT_PROVIDED`/`AMBIGUOUS`/`INVALID`), `clarificationPrompt`, `expiresAt`, plus
`flags`/`modelMetadata` for consistency with Phases 1-3.

Out of scope (deferred): actually sending the clarification question to the customer over a channel
(Phase 5's channel adapters), a real conversational loop that re-processes the customer's reply
against the same missing fields (that's Steps 1-3 being re-invoked, plus the still-not-built
Event/Workflow Engine that sequences journey steps — unchanged from Phases 2-3's notes), and
eligibility/availability checks (Steps 5-6).

## 3. Design decisions

- **No new "AI proposes" step — this phase is fully deterministic aggregation.** Unlike Steps 1-3,
  there is no new unstructured text to interpret here: every signal Phase 4 reads already went
  through its own step's "AI proposes, deterministic domain logic verifies" pipeline. So
  `RequiredFieldsEvaluator` and `MissingInfoOrchestrator` are plain synchronous, pure
  functions/classes — no `async`, no I/O, trivially unit-testable — with all the actual DB reads
  living in the API service layer (`apps/api`), which fetches the three snapshots and hands them in.
- **Narrow snapshot interfaces, not the full Steps 1-3 result types.** `IntentSnapshot`/
  `DateLocationSnapshot`/`VehicleSnapshot` (`packages/ai/src/step4/requiredFieldsEvaluator.ts`)
  carry only the handful of fields this phase actually needs, so they're trivial to construct from a
  stored Prisma row (a few field picks + a cast on the `Json` columns) rather than needing to
  reconstruct an entire original Zod-inferred result shape from a partial DB row.
- **Four required fields, matching Phase 1's own `BOOKING_REQUIRED_FIELDS` intent** (`vehicleIntent`,
  `pickupDate`, `returnDate`, `location`), now upgraded from Phase 1's crude "is there some keyword
  evidence" check to the real, deterministically-verified values Steps 2-3 produced:
  `PICKUP_DATE`, `RETURN_DATE`, `PICKUP_LOCATION`, `VEHICLE`. `dropoffLocation` is deliberately
  **not** required — most rentals return to the pickup point, and Phase 2 explicitly left this
  decision "for a later step to ask about"; this is that step, and the decision is to not force it.
- **Three distinct reasons a field counts as missing**, each producing a different clarification
  phrase: `NOT_PROVIDED` (the underlying step never ran, or ran and found nothing),
  `AMBIGUOUS` (Step 2/3 found something but flagged it as an ambiguity — surfaces that ambiguity's
  own message), `INVALID` (Step 2/3 found something but rejected it — e.g. `PAST_DATE`,
  `VEHICLE_INACTIVE` — surfaces that validation error's own message). `INVALID` is checked before
  `AMBIGUOUS` for the date fields, since a resolved-but-rejected value is a more specific signal than
  a resolved-but-uncertain one.
- **`NOT_APPLICABLE` is a distinct status from `COMPLETE`.** A non-`BOOKING_REQUEST` intent (e.g. a
  price question, a complaint) has nothing to "complete" — collapsing this into `COMPLETE` would
  make an analytics/dashboard view unable to tell "this booking is ready" from "this was never a
  booking to begin with". Mirrors Phase 1's own `RuleBasedIntentEngine`, which already only computes
  `missingFields` when `intentType === BOOKING_REQUEST`.
  Precedence when both could apply: `NOT_APPLICABLE` is checked before completeness, and `EXPIRED`
  only overrides `NEEDS_INFO` (an already-`COMPLETE` conversation is never later marked `EXPIRED`
  just because 24h passed — there's nothing left to time out).
- **The 24h timeout clock starts at the conversation's `createdAt`**, not the latest message's —
  MASTER-PLAN.md's "loop until complete or timeout" describes the conversation's overall collection
  window, not any single reply's freshness. `MISSING_INFO_TIMEOUT_HOURS = 24` lives in
  `packages/domain` so both the evaluator and any future caller share one source of truth.
- **The clarification prompt is deterministic and template-based, not an LLM call** — same
  zero-hallucination discipline as Steps 1-3. One combined question (Oxford-comma joined) rather than
  one message per gap, so a customer replying once can address everything still missing instead of
  being asked several separate questions in a row.
- **`VehicleDetermination`'s `resolvedVehicle` relation is now `include`d, and `toDomainVehicle` is
  exported** from `vehicleRepository.ts` for reuse — Phase 3 only ever needed the bare
  `resolvedVehicleId`; Phase 4 is the first caller that needs the actual vehicle record (for
  `collected.vehicle`), so the repository function grew an `include` rather than Phase 4 re-querying
  redundantly. Backward compatible: existing callers only used fields still present on the result.
- **A fourth append-only-history table, `MissingInfoCheck`**, matching `IntentRecord`/
  `DateLocationExtraction`/`VehicleDetermination`'s convention exactly: one row per check, storing the
  Zod-validated engine output verbatim, audited in the same transaction.
- **New API endpoint, not a body-accepting one**, matching Steps 2-3's pattern exactly:
  `POST /v1/enquiries/:conversationId/missing-info` takes no request body — it operates on whatever
  Steps 1-3 have already stored for the conversation's latest message.

## 4. What was built

- `packages/domain/src/missingInfo.ts` — `RequiredField`, `MissingFieldReason`, `MissingInfoStatus`,
  `MISSING_INFO_TIMEOUT_HOURS`, `missingFieldSchema`, `collectedBookingInfoSchema` (reusing
  `normalizedLocationSchema`/`vehicleSchema`), `missingInfoResultSchema`.
- `packages/ai/src/step4/` — `requiredFieldsEvaluator.ts` (`RequiredFieldsEvaluator`, the narrow
  `IntentSnapshot`/`DateLocationSnapshot`/`VehicleSnapshot` input types),
  `clarificationPromptBuilder.ts` (`buildClarificationPrompt`), `orchestrator.ts`
  (`MissingInfoOrchestrator`).
- `packages/db`: `MissingInfoCheck` model + `MissingInfoStatus` enum (migration
  `20260917035136_add_missing_info_check`), `missingInfoCheckRepository.ts`,
  `findLatestIntentRecordForMessage` added to `intentRepository.ts`.
- `packages/contracts/src/missingInfo.ts` — request/response schemas for the new endpoint.
- `apps/api`: `services/missingInfoService.ts` (fetches the conversation + latest message + latest
  per-step records in parallel, maps Prisma rows to the narrow snapshot inputs, transaction + audit),
  `routes/v1/missingInfo.ts` (`POST /v1/enquiries/:conversationId/missing-info`),
  `missingInfoOrchestrator` added to `AppContext`.
- `packages/testing/src/db.ts` — `missing_info_checks` added to the truncation list.

## 5. APIs

| Method | Path                                         | Purpose                                                                           |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/v1/enquiries/:conversationId/missing-info` | Run Step 4 against the conversation's latest message; persist + return the result |

Request/response schemas: `packages/contracts/src/missingInfo.ts`; live in the OpenAPI doc at `/docs`.

## 6. Database schema

`MissingInfoCheck` (`MissingInfoStatus` enum: COMPLETE/NEEDS_INFO/EXPIRED/NOT_APPLICABLE) — see
`packages/db/prisma/schema.prisma` and
`packages/db/prisma/migrations/20260917035136_add_missing_info_check/`. Same append-only-history
convention as `IntentRecord`/`DateLocationExtraction`/`VehicleDetermination`: tenant-scoped, stores
the Zod-validated engine output verbatim, one row per check (not upserted).

Additive change to `VehicleDetermination`'s read path: `findLatestVehicleDeterminationForMessage`
now `include`s the related `resolvedVehicle` row — no schema/migration change, just a richer query.

## 7. Security decisions

**Implemented and tested:**

- **Never re-parses raw text.** Every input to `RequiredFieldsEvaluator` is a value Steps 1-3 already
  extracted and deterministically verified; Phase 4 cannot itself hallucinate a date, location, or
  vehicle — it can only read what already passed through an earlier step's validation.
- **Tenant isolation** — every repository read (`findConversationById`,
  `findLatestMessageForConversation`, `findLatestIntentRecordForMessage`,
  `findLatestDateLocationExtractionForMessage`, `findLatestVehicleDeterminationForMessage`) is
  explicitly `tenantId`-scoped; proven with an API-level defense-in-depth test mirroring Phases 2-3's.
- **Audit events** — every check writes an `AuditEvent` (`missing_info.checked`) in the same Prisma
  transaction as the `MissingInfoCheck` row.
- **Prompt-injection visibility carried forward, not re-detected.** Phase 4 doesn't run its own
  sanitizer (there's no new raw text to sanitize); it aggregates the `promptInjectionDetected` flag
  already set by whichever of Steps 1-3 actually saw the injection attempt into one
  `promptInjectionDetectedAnywhere` flag, proven end to end with a real injection payload.
- **SQL injection** — Prisma parameterized queries only; proven with a payload embedded directly in
  the enquiry message reaching this endpoint end to end.
- **Zod-validated before it leaves the orchestrator**, same as every prior phase.

**Explicitly deferred (documented, not silently skipped):**

- Database-level Row Level Security — still application-level only, unchanged from Phases 1-3.
- Actually delivering the clarification prompt to the customer over a real channel — Phase 5 scope.

## 8. Test results

All commands run against real local PostgreSQL 16 + Redis 7 (same sandbox as Phases 1-3; Docker
daemon still unavailable here).

| Gate        | Command                 | Result                                             |
| ----------- | ----------------------- | -------------------------------------------------- |
| Typecheck   | `pnpm typecheck`        | ✅ 11/11 packages                                  |
| Lint        | `pnpm lint`             | ✅ 0 errors, 0 warnings                            |
| Format      | `pnpm format:check`     | ✅ clean                                           |
| Unit        | `pnpm test:unit`        | ✅ 302 tests (was 260 in Phase 3 — 42 new)         |
| Integration | `pnpm test:integration` | ✅ 64 tests (was 53 — 11 new)                      |
| Security    | `pnpm test:security`    | ✅ 37 tests (was 33 — 4 new)                       |
| E2E         | `pnpm test:e2e`         | ✅ 4 tests, unchanged from Phase 1 (no UI touched) |
| Build       | `pnpm build`            | ✅ every package + Next.js production build        |

**Total: 407 automated tests, all passing** — the full Phase 1-3 suite re-run and green (regression
requirement), plus Phase 4's new coverage.

Key scenarios, covered at the unit (`packages/ai/src/step4/*.test.ts`, zero I/O) and live-HTTP
(`apps/api/src/missingInfo.integration.test.ts` / `missingInfo.security.test.ts`) layers:

| Case                                                    | Where                          | Result                                                |
| ------------------------------------------------------- | ------------------------------ | ----------------------------------------------------- |
| all four fields resolved                                | evaluator + orchestrator + API | `COMPLETE`, no missing fields, no prompt              |
| a step never run at all                                 | evaluator + orchestrator + API | `NOT_PROVIDED` for that field                         |
| Step 2 flagged an ambiguity (e.g. ambiguous date)       | evaluator                      | `AMBIGUOUS`, carries the ambiguity's own message      |
| Step 2/3 rejected a value (past date, inactive vehicle) | evaluator                      | `INVALID`, carries the validation error's own message |
| still incomplete past the 24h window                    | evaluator + orchestrator + API | `EXPIRED`, no clarification prompt                    |
| non-booking intent (e.g. a price question)              | evaluator + orchestrator + API | `NOT_APPLICABLE`, nothing to collect                  |
| prompt injection flagged by an earlier step             | API (security)                 | `flags.promptInjectionDetectedAnywhere: true`         |
| tenant isolation                                        | API (security)                 | 404 defense-in-depth, same convention as Phases 2-3   |

## 9. Known limitations

- **`RequiredField` is fixed at four fields.** Adding a fifth required field (e.g. a driver
  requirement) is a small, additive change to the evaluator, not an architecture change — but it
  isn't parametrized/configurable per tenant yet.
- **The clarification prompt is English-only and template-based** — same class of limitation as
  Phases 1-3's lexicons; a real multi-language/LLM-authored prompt is Phase 4 (original numbering)/
  later scope.
- **No real conversational loop.** This endpoint computes the current completeness snapshot; nothing
  yet re-invokes Steps 1-3 automatically when the customer replies to the clarification prompt, or
  delivers that prompt over a channel — both are later-phase scope (the Event/Workflow Engine and
  Phase 5's channel adapters, respectively).
- **No Docker daemon in this dev sandbox** (same as Phases 1-3) — `docker-compose.yml` unaffected and
  correct for normal local/CI use.

## 10. Files created

- `packages/domain/src/missingInfo.ts`, `packages/domain/src/missingInfo.test.ts`
- `packages/ai/src/step4/*.ts` and matching `*.test.ts` (requiredFieldsEvaluator,
  clarificationPromptBuilder, orchestrator)
- `packages/db/prisma/migrations/20260917035136_add_missing_info_check/migration.sql`
- `packages/db/src/repositories/missingInfoCheckRepository.ts` (+ `.test.ts`)
- `packages/contracts/src/missingInfo.ts` (+ `.test.ts`)
- `apps/api/src/services/missingInfoService.ts` (+ `.test.ts`)
- `apps/api/src/routes/v1/missingInfo.ts`
- `apps/api/src/missingInfo.integration.test.ts`, `apps/api/src/missingInfo.security.test.ts`
- `docs/PHASE-4.md` (this file)

## 11. Files modified

- `packages/ai/src/index.ts`, `packages/domain/src/index.ts`, `packages/contracts/src/index.ts`,
  `packages/db/src/index.ts` — new exports added.
- `packages/db/prisma/schema.prisma` — added `MissingInfoCheck` model and its enum, relations from
  `Tenant`/`Message`.
- `packages/db/src/repositories/intentRepository.ts` — added `findLatestIntentRecordForMessage`
  (additive; existing `createIntentRecord` unchanged).
- `packages/db/src/repositories/vehicleDeterminationRepository.ts` —
  `findLatestVehicleDeterminationForMessage` now includes the related `resolvedVehicle` row.
- `packages/db/src/repositories/vehicleRepository.ts` — `toDomainVehicle` exported for reuse.
- `packages/testing/src/db.ts` — `missing_info_checks` added to `TABLES`.
- `apps/api/src/context.ts`, `apps/api/src/server.ts`, `apps/api/src/test/buildTestApp.ts`,
  `apps/api/src/app.ts` — `missingInfoOrchestrator` wired into `AppContext`; new route registered.
- `docs/ARCHITECTURE.md`, `docs/PHASE-CONTRACTS.json` — updated for Phase 4.

No working Phase 1-3 functionality was changed; no dead code was found to remove (`npx depcheck`
clean on every touched package, no leftover TODOs/console.log).

## 12. Migration status

One new migration applied and verified on both dev and test databases:
`20260917035136_add_missing_info_check` (forward migration path exercised via `prisma migrate dev` /
`prisma migrate deploy`, same convention as Phases 1-3). A full destructive
`prisma migrate reset` replay was not additionally performed, for the same reason recorded in
`docs/PHASE-3.md` §9 (Prisma's own AI-safety guard requires explicit human consent for that action).

## 13. Phase 5 contract (proposed inputs for the next phase)

Per `MASTER-PLAN.md` §4, journey Step 5 is **Eligibility** (`ELIGIBILITY_CHECK`, tenant rules: min age
per class, licence type, residency, blocklist, deposit ability). Per `PHASE-CONTRACTS.json`'s
`phaseNumbering` note, the document's current phase-id-5 entry ("Channels, Documents, Payments, CRM &
Fulfilment") is the original 10-phase-breakdown placeholder, not yet reconciled with the journey-step
numbering Phases 1-4 have actually followed — the same situation Phases 2 and 3 each resolved for
their own entries. Should build on:

- `IntentRecord`, `DateLocationExtraction`, `VehicleDetermination`, and `MissingInfoCheck` are now
  all independently queryable per-conversation; Step 5 reads them the same tenant-scoped way.
- Reuse the "AI proposes, deterministic domain logic verifies" split and the `*ResultSchema`-style
  pattern (always Zod-validate the final result) a fifth time — though eligibility, like Step 4, may
  turn out to need no new "AI proposes" step at all (tenant rules are deterministic by nature).
- Do not build the real Event/Workflow Engine (journey state machine) here — still a distinct, larger
  phase per `MASTER-PLAN.md`, unchanged from Phases 2-3's notes.

Do not start Phase 5 until asked.
