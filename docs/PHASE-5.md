# Phase 5 — Eligibility Engine (journey Step 5 — `ELIGIBILITY_CHECK`)

Status: **FROZEN** (`PHASE-CONTRACTS.json` id 11 — the journey-step-numbered continuation of
Phases 1-4, not id 5's original "Channels, Documents, Payments, CRM & Fulfilment" scope; see §1)

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`, `docs/MASTER-PLAN.md`.
- `docs/DESIGN-SYSTEM.md` was not read in depth — this phase touches no UI (`apps/web` is
  untouched); MASTER-PLAN.md journey Step 5 (`ELIGIBILITY_CHECK`) is a `SYS`-owned backend
  decision, with any admin-facing policy management deferred to Phase 7.
- Found a real naming collision before writing any code: `docs/PHASE-CONTRACTS.json`'s `id: 5`
  entry ("Channels, Documents, Payments, CRM & Fulfilment") was already `IN_PROGRESS`, with a real
  WhatsApp adapter slice documented in `docs/PHASE-5.md` — the exact filename this phase was asked
  to write to. That doc's own §13 had explicitly flagged Eligibility (journey Step 5) as the
  logically "correct" next step but left the decision to the user. Resolved with the user before
  writing any code: renamed the existing doc to `docs/PHASE-5-CHANNELS.md` (content otherwise
  untouched, its `PHASE-CONTRACTS.json` entry still `IN_PROGRESS` and unaffected), and gave this
  phase its own `PHASE-CONTRACTS.json` entry (`id: 11` — the next free integer, chosen over a
  renumber or a fractional id specifically so ids 1-10 and their `dependsOn` chains stay untouched;
  `dependsOn: [4]`, matching the real dependency).
- Read `docs/PHASE-4.md` (previous journey-step phase) and its §13 forward contract, which named
  Eligibility as the correct next step.
- Inspected the repository; local PostgreSQL 16 + Redis 7 confirmed reachable; ran the existing
  Phase 1-4 suite before changing anything (baseline: typecheck/lint/format all green, 417 unit +
  104 integration + 57 security + 4 e2e tests, production build green).

## 2. Scope

Goal: given validated customer data, the vehicle/dates/location Steps 2-3 already resolved, and
driver requirements, deterministically decide `ELIGIBLE` / `INELIGIBLE` / `NEEDS_HUMAN_REVIEW`
against a tenant-configurable policy — MASTER-PLAN.md journey Step 5, `ELIGIBILITY_CHECK`, `SYS`
owner. Unlike Steps 1-4, there is **no AI proposal stage anywhere in this phase**: age, license
type, passport status and nationality are genuinely new inputs (no earlier step collects them), so
they arrive as validated request-boundary input rather than something to extract from free text.

**In scope:**

- `EligibilityPolicy` — tenant-scoped, versioned, configurable rule parameters (age minimums,
  accepted license types, passport requirement, nationality allow/block lists, per-vehicle-tier
  restrictions, restricted cities, additional-driver requirements).
- `EligibilityRule` — 7 deterministic, independently testable rule implementations: AGE, LICENSE,
  PASSPORT, NATIONALITY, VEHICLE, LOCATION, DRIVER_REQUIREMENT.
- `EligibilityException` — tenant-configured, pre-approved carve-outs (VIP, nationality override,
  age override, manual grant), each with its own risk level.
- `EligibilityDecision` — the auditable, append-only result of one check.
- `POST /v1/enquiries/:conversationId/eligibility`.
- A default policy seeded for the demo tenant.

**Out of scope (deferred, unchanged from every prior phase's notes):**

- An admin UI/endpoint to manage policies or exceptions — Phase 7 (Admin Dashboard) scope; this
  phase proves the engine is genuinely policy-driven via `packages/db/src/seed.ts` and direct
  repository calls, not via hardcoded rule logic.
- Real availability/holds, quotes, documents, payments, CRM, delivery/return, the real persisted
  Event/Workflow Engine — unchanged, still `PENDING`/not built (see `docs/PHASE-5-CHANNELS.md`).
- Wiring this endpoint into `runFullEnquiryPipeline` (the WhatsApp auto-pipeline) — that pipeline
  still only runs Steps 1-4; extending it to Step 5 was not asked for and would combine two
  independently-scoped phases' surface area.

## 3. Design decisions

- **Zero AI involvement, by construction.** CLAUDE.md/the task brief are explicit: "AI may explain
  rules but MUST NOT decide policy independently" / "Never allow AI to override policy." Every file
  in `packages/ai/src/step5` is pure, synchronous, and reads only its own `context`/`policy`
  arguments — no `AIProvider`, no network call, no non-determinism anywhere in the decision path.
  This is a stronger guarantee than Steps 1-4 make (which do call proposal services) because there
  is _no proposal step to guard against_ here at all.
- **Customer/driver data is the request body; vehicle/dates/location are read from the
  conversation.** Age, nationality, license type/validity and passport status have never been
  collected by any earlier step, so `checkEligibilityBodySchema` (`.strict()`) is genuinely new
  validated input — the one part of this step that _is_ a request body, unlike Steps 2-4. The
  vehicle/dates/location Steps 2-3 already resolved are read via
  `findLatestDateLocationExtractionForMessage`/`findLatestVehicleDeterminationForMessage`, the exact
  same "read what was already verified, never re-derive" convention Step 4 established.
- **Policy is data, rules are code.** `EligibilityPolicyRules` (age minimums, accepted license
  types, passport requirement, nationality lists, per-tier restrictions, restricted cities, driver
  requirements) is a tenant-scoped, Zod-validated JSON blob a rule reads at evaluation time; the
  rule's _logic_ (how to compare an age, how to check a license type) is fixed code in
  `packages/ai/src/step5/rules`. This is what "deterministic and configurable" means in practice:
  a tenant reconfigures every number/list without a code change, but nothing about _how_ a rule is
  checked is ever data-driven or AI-driven.
- **`EligibilityPolicy` is versioned and append-only, matching every other step's history
  convention.** `createEligibilityPolicyVersion` inserts a new row and deactivates every previous
  version in one transaction, rather than updating a row in place — so a past `EligibilityDecision`
  always carries the exact `policyId`/`policyVersion` that produced it, even after the tenant
  reconfigures the policy tomorrow.
- **A rule fails or passes on its own; exceptions are resolved afterward, separately.** Each
  `EligibilityRule.evaluate()` only ever returns `PASS`/`FAIL` — it has no knowledge of exceptions.
  `resolveWithExceptions` (a separate, dedicated function) then looks up whether a `FAIL`ed rule's
  category is covered by one of the customer's applicable, tenant-configured exceptions. A LOW-risk
  exception auto-waives the rule (`WAIVED`); a HIGH-risk one is recorded as matching but is **never**
  auto-applied (`REQUIRES_REVIEW`) — this is the concrete mechanism behind "High-risk exceptions ->
  human." Keeping this as a second pass over already-computed rule results (rather than letting a
  rule "know" about exceptions) keeps each rule's own logic simple and keeps the exception-risk
  policy in exactly one place.
- **A hard, unwaived failure always outranks a pending high-risk exception.** If a customer both
  fails an unwaivable rule (no matching exception at all) _and_ has a HIGH-risk exception pending on
  a different rule, the orchestrator returns `INELIGIBLE`, not `NEEDS_HUMAN_REVIEW` — there is no
  point routing a human to approve an exception for a booking that is categorically ineligible for
  an unrelated reason. Covered by `orchestrator.test.ts`'s "an unwaivable failure elsewhere still
  wins over a pending high-risk exception."
- **A tenant's own policy can be internally inconsistent — fail safe, never guess.**
  `validateEligibilityPolicy` checks the loaded policy for structural conflicts (currently: a
  nationality present in both the blocked and allowed-only lists; a vehicle-tier minimum age
  configured _below_ the global minimum) before any rule runs. Any conflict short-circuits straight
  to `NEEDS_HUMAN_REVIEW` with `flags.policyConflictDetected = true` and an empty `ruleResults` —
  evaluating rules against a policy nobody can be sure is correct would itself be an implicit,
  undocumented decision this engine must never make on its own.
- **The reason string is a deterministic template, never free text.** `buildEligibilityReason`
  composes one human-readable summary from the computed status/rule results/exceptions — no AI call,
  matching `clarificationPromptBuilder`'s precedent from Step 4.
- **Exceptions are validated before they're written, not just on read.** The code-review pass this
  phase ran (see §8) caught that `createEligibilityException` accepted `waivedCategories`/
  `scopeNationality` with no Zod check, unlike `createEligibilityPolicyVersion`'s
  `eligibilityPolicyRulesSchema.parse`. A malformed row would otherwise only surface later, as an
  uncaught `eligibilityExceptionSchema.parse` failure in `findApplicableEligibilityExceptions` —
  breaking eligibility checks for _every_ customer of that tenant, not just the one the bad row was
  scoped to. Fixed by adding `createEligibilityExceptionInputSchema` (domain) and validating against
  it before every write.

## 4. What was built

- `packages/domain/src/eligibility.ts` (new) — `LicenseType`; `EligibilityRuleCategory`/`Outcome`;
  `EligibilityExceptionType`/`RiskLevel`; `driverInputSchema`/`eligibilityCustomerInputSchema`
  (request-boundary input, with a hand-rolled `dateOfBirth` calendar-date + not-in-future check,
  Zod v3 has no built-in date-string validator); `EligibilityPolicyRules`/`EligibilityPolicy`;
  `EligibilityException` + `createEligibilityExceptionInputSchema`; `PolicyConflictCode`;
  `EligibilityDecisionStatus`/`Result`.
- `packages/ai/src/step5/` (new package directory) — `types.ts` (`EligibilityRule`,
  `EligibilityCheckContext`), `age.ts` (`calculateAgeAt`), `rules/{ageRule,licenseRule,passportRule,
nationalityRule,vehicleRule,locationRule,driverRequirementRule}.ts` + `rules/index.ts`
  (`ELIGIBILITY_RULES`), `policyValidator.ts` (`validateEligibilityPolicy`), `exceptionResolver.ts`
  (`resolveWithExceptions`), `reasonBuilder.ts` (`buildEligibilityReason`), `orchestrator.ts`
  (`EligibilityOrchestrator`), `test/fixtures.ts` (shared, non-`.test.ts` unit-test fixtures — same
  pattern as `apps/api/src/test/fakeWhatsAppProvider.ts`).
- `packages/db/prisma/schema.prisma` — `EligibilityPolicy`, `EligibilityException`,
  `EligibilityDecision` models + `EligibilityDecisionStatus`/`EligibilityExceptionType`/
  `EligibilityRiskLevel` enums; migration `20260923134719_add_eligibility_engine` (purely additive —
  3 new tables + 3 new enums, no change to any existing table).
- `packages/db/src/repositories/{eligibilityPolicyRepository,eligibilityExceptionRepository,
eligibilityDecisionRepository}.ts` — `toDomainEligibilityPolicy`/`toDomainEligibilityException`
  (Zod-re-validated reads, same convention as `toDomainVehicle`),
  `findActiveEligibilityPolicy`/`createEligibilityPolicyVersion` (versioned, append-only),
  `createEligibilityException`/`findApplicableEligibilityExceptions` (validated writes, tenant +
  customerRef/nationality-scoped reads), `createEligibilityDecision`/
  `findLatestEligibilityDecisionForMessage` (append-only history, same convention as
  `vehicleDeterminationRepository`).
- `packages/contracts/src/eligibility.ts` — `checkEligibilityParamsSchema`,
  `checkEligibilityBodySchema` (`.strict()`), `checkEligibilityResponseSchema`.
- `apps/api/src/services/eligibilityService.ts` + `apps/api/src/routes/v1/eligibility.ts` —
  `POST /v1/enquiries/:conversationId/eligibility`; wired into `context.ts`, `app.ts`, `server.ts`,
  `test/buildTestApp.ts`.
- `packages/db/src/seed.ts` — a sensible default `EligibilityPolicy` (min age 21, ULTRA_LUXURY tier
  25, UAE/GCC/IDP licenses accepted, passport required, 2 additional drivers max) seeded for the
  demo tenant, idempotently (only creates version 1 once; re-running the seed never creates a new
  version).
- `packages/testing/src/db.ts` — the three new tables added to the shared `truncateAllTables` list.

## 5. APIs

| Method | Path                                        | Purpose                                           |
| ------ | ------------------------------------------- | ------------------------------------------------- |
| POST   | `/v1/enquiries/:conversationId/eligibility` | Runs Step 5 for the conversation's latest message |

Request body: `{ customer: {...}, additionalDrivers?: [...] }` (Zod `.strict()` — see
`packages/contracts/src/eligibility.ts`). Response: `{ conversationId, messageId, decision }`. Live
in the OpenAPI doc at `/docs`.

## 6. Database schema

New tables (migration `20260923134719_add_eligibility_engine`, purely additive):

- `eligibility_policies` — tenant-scoped, versioned (`@@unique([tenantId, version])`), one `active`
  row per tenant at a time.
- `eligibility_exceptions` — tenant-scoped, scoped by `scopeCustomerRef` or `scopeNationality`,
  `waivedCategories: String[]`, `riskLevel`, `expiresAt`.
- `eligibility_decisions` — tenant + message scoped, append-only, FK to the `EligibilityPolicy` row
  actually evaluated.

No existing table's columns changed.

## 7. Security decisions

**Implemented and tested:**

- **Zero AI/LLM calls in the decision path** — proven by construction (no `AIProvider` import
  anywhere in `packages/ai/src/step5`) and by the orchestrator's own tests.
- **The request body cannot dictate its own outcome.** `.strict()` rejects any unrecognized field —
  proven with an explicit attempt to smuggle `status`/`policyId`/`decision` fields into the body, and
  a prototype-pollution-shaped payload (`__proto__`/`constructor.prototype`), both 400, neither ever
  reaching the service layer.
- **Every customer-declared field is a narrow enum/regex, not free text.** Nationality, license
  type, and date of birth all reject malformed/adversarial values (a SQL-injection-shaped
  nationality, an out-of-range calendar date, a future date of birth) with 400 before anything
  touches the database.
- **Tenant isolation, both directions.** A conversation force-moved to another tenant 404s (defense
  in depth, matching Steps 2-4's own tests); a policy/exception created for a _different_ tenant is
  never read into another tenant's evaluation (proven at both the repository level and end-to-end
  through the route).
- **Missing tenant configuration is never a fake success.** No active policy → `501 NOT_CONFIGURED`,
  never an invented "ELIGIBLE"/"INELIGIBLE".
- **A tenant's own inconsistent policy fails safe** — `NEEDS_HUMAN_REVIEW`, never a guessed
  resolution (§3).
- **Exceptions validated before write** (§3) — a malformed exception can no longer break every
  subsequent read for that tenant.
- **Audit event on every decision** (`eligibility.decided`), in the same transaction as the
  `EligibilityDecision` row.
- **Zod-validated at every new boundary** — the request body, the policy JSON (on write and on every
  read), the exception row (on write and on every read), the decision result.

**Explicitly deferred (documented, not silently skipped) — unchanged from every prior phase:**

- Database-level Row Level Security — still application-level only.
- Least-privilege DB roles/tokens, rate limiting beyond the API-wide limiter — Phase 6 scope.
- Admin management of policies/exceptions — Phase 7 scope; today only seed/repository calls create
  them.

## 8. Test results

All commands run against real local PostgreSQL 16 + Redis 7 (no Docker daemon in this sandbox, same
as every prior phase).

| Gate                | Command                          | Result                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck           | `pnpm typecheck`                 | ✅ 12/12 packages                                                                                                                                                                                                                                                                                                                                                |
| Lint                | `pnpm lint`                      | ✅ 0 errors, 0 warnings                                                                                                                                                                                                                                                                                                                                          |
| Format              | `pnpm format:check`              | ✅ clean                                                                                                                                                                                                                                                                                                                                                         |
| Unit                | `pnpm test:unit`                 | ✅ 465 tests (+48 over the 417-test baseline — exactly this phase's new step5 suite; every pre-existing package's own count confirmed unchanged)                                                                                                                                                                                                                 |
| Integration         | `pnpm test:integration`          | ✅ 128 tests (+24 over the 104-test baseline)                                                                                                                                                                                                                                                                                                                    |
| Security            | `pnpm test:security`             | ✅ 66 tests (+9 over the 57-test baseline)                                                                                                                                                                                                                                                                                                                       |
| E2E                 | `pnpm test:e2e`                  | ✅ 4 tests, unchanged (no UI touched)                                                                                                                                                                                                                                                                                                                            |
| Build               | `pnpm build`                     | ✅ every package + Next.js production build                                                                                                                                                                                                                                                                                                                      |
| Code review         | `/code-review high`              | ✅ 2 real findings fixed pre-freeze (exception-write validation, seed.ts reusing the repository helper instead of an inline query); 1 finding judged consistent with pre-existing convention and left as-is (decision-history reads return the raw Prisma row elsewhere too — `findLatestVehicleDeterminationForMessage`/`findLatestMissingInfoCheckForMessage`) |
| Architecture review | checklist vs MASTER-PLAN §1/§6   | ✅ matches target `packages/ai`/`packages/db` responsibility split; zero AI calls in a `SYS`-owned step, matching the architecture diagram exactly; no deviations                                                                                                                                                                                                |
| Regression          | `pnpm test` (final commit)       | ✅ full Phase 1-4 suite + this phase's, all green (exit 0)                                                                                                                                                                                                                                                                                                       |
| Migrations          | fresh DB `migrate deploy` + seed | ✅ all 6 migrations apply cleanly in order on a brand-new database; seed idempotent (re-run creates no new policy version)                                                                                                                                                                                                                                       |

**Total: 663 automated tests, all passing** (465 unit + 128 integration + 66 security + 4 e2e).

Mandatory test scenarios (`packages/ai/src/step5/orchestrator.test.ts`,
`apps/api/src/eligibility.integration.test.ts`, `apps/api/src/eligibility.security.test.ts`):

| Case                  | Result                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid customer        | `ELIGIBLE`, all 7 rules `PASS`, no exceptions, no policy conflicts                                                                           |
| Underage              | `INELIGIBLE`, `AGE` rule `FAIL`, no matching exception                                                                                       |
| Missing license       | `INELIGIBLE`, `LICENSE` rule `FAIL` ("no valid driving license was declared")                                                                |
| Invalid license       | `INELIGIBLE`, `LICENSE` rule `FAIL` (license type not in the tenant's accepted list)                                                         |
| Nationality exception | LOW-risk `NATIONALITY_OVERRIDE` auto-waives the failed `NATIONALITY` rule → `ELIGIBLE`                                                       |
| VIP exception         | HIGH-risk `VIP` exception never auto-applies → `NEEDS_HUMAN_REVIEW`, rule marked `REQUIRES_REVIEW`                                           |
| Policy conflict       | A nationality in both the blocked and allowed-only lists → `NEEDS_HUMAN_REVIEW`, `flags.policyConflictDetected = true`, zero rules evaluated |
| Tampered request      | An extra `status`/`policyId`/`decision` field, or a `__proto__`-shaped payload → 400, nothing persisted                                      |
| Tenant isolation      | A cross-tenant conversation 404s; a policy/exception seeded for another tenant is never read into this tenant's decision                     |

## 9. Known limitations

- **No admin endpoint to manage policies/exceptions yet.** Genuinely deferred to Phase 7 (Admin
  Dashboard); today a tenant's policy/exceptions can only be changed via `packages/db/src/seed.ts`
  or a direct repository call (exercised thoroughly by this phase's own tests, so the engine's
  policy-driven behavior is proven, just not yet reachable through a UI or authenticated endpoint).
- **Not wired into `runFullEnquiryPipeline`.** The WhatsApp auto-pipeline (`docs/PHASE-5-CHANNELS.md`)
  still only runs Steps 1-4; a customer's WhatsApp conversation does not automatically continue into
  an eligibility check. Extending that pipeline is a natural next step but combines two
  independently-scoped phases' surface area and was not part of this task.
- **`EligibilityRule` set is fixed at 7 categories.** MASTER-PLAN.md journey Step 5 also mentions
  "residency" and "blocklist"/"deposit ability" as example rule shapes; residency/blocklist are
  covered by the NATIONALITY/PASSPORT rules' existing configurability (a tenant can express a
  residency requirement via `passportRequired` plus a nationality allowlist), but "deposit ability"
  (a financial capability check) has no dedicated rule yet — it depends on payment/deposit data this
  phase was not asked to collect and that doesn't exist anywhere in the system yet (Payments is
  still `PENDING`, id 5's original scope). Left as a candidate additional rule category for a future
  phase, not invented here without real requirements to build it against.
- **`EligibilityPolicy`'s two structural-conflict checks are a starting set,** not exhaustive
  (`validateEligibilityPolicy`, §3) — e.g. a `vehicleRestrictions` entry whose `minAge` is below the
  tier's own `minAgeByLuxuryTier` entry is not currently flagged as a conflict (it's merely
  redundant, since `ageRule` already enforces the higher of the two independently via
  `minAgeByLuxuryTier`, and `vehicleRule` enforces `vehicleRestrictions` separately — so this
  specific shape doesn't produce an incorrect decision, just an unflagged redundancy). Additional
  conflict rules can be added to `validateEligibilityPolicy` without touching any rule or the
  orchestrator.
- No Docker daemon in this dev sandbox (unchanged from every prior phase).

## 10. Files created

- `packages/domain/src/eligibility.ts` (+ implicit test coverage via `packages/ai/src/step5`'s own
  suite, which exercises every exported schema)
- `packages/ai/src/step5/{types,age}.ts` (+ `age.test.ts`)
- `packages/ai/src/step5/rules/{ageRule,licenseRule,passportRule,nationalityRule,vehicleRule,
locationRule,driverRequirementRule,index}.ts` (+ matching `.test.ts` per rule)
- `packages/ai/src/step5/{policyValidator,exceptionResolver,reasonBuilder,orchestrator}.ts` (+
  matching `.test.ts`)
- `packages/ai/src/step5/test/fixtures.ts`
- `packages/db/prisma/migrations/20260923134719_add_eligibility_engine/migration.sql`
- `packages/db/src/repositories/{eligibilityPolicyRepository,eligibilityExceptionRepository,
eligibilityDecisionRepository}.ts` (+ matching `.test.ts`)
- `packages/contracts/src/eligibility.ts`
- `apps/api/src/services/eligibilityService.ts`
- `apps/api/src/routes/v1/eligibility.ts`
- `apps/api/src/eligibility.integration.test.ts`, `apps/api/src/eligibility.security.test.ts`
- `docs/PHASE-5.md` (this file)

## 11. Files modified

- `packages/db/prisma/schema.prisma` — additive `EligibilityPolicy`/`EligibilityException`/
  `EligibilityDecision` models + enums, plus back-relations on `Tenant`/`Message`.
- `packages/domain/src/index.ts`, `packages/ai/src/index.ts`, `packages/db/src/index.ts`,
  `packages/contracts/src/index.ts` — new exports added.
- `packages/db/src/seed.ts` — additive default `EligibilityPolicy` seeding.
- `packages/testing/src/db.ts` — three new tables added to `truncateAllTables`.
- `apps/api/src/context.ts`, `app.ts`, `server.ts`, `test/buildTestApp.ts` — `eligibilityOrchestrator`
  wired into `AppContext`; new route registered.
- `docs/ARCHITECTURE.md`, `docs/PHASE-CONTRACTS.json`, `README.md` — updated for this phase; see §1
  for the `docs/PHASE-5.md`/`docs/PHASE-5-CHANNELS.md` rename and the new `id: 11` contract entry.
- `docs/PHASE-5-CHANNELS.md` (renamed from `docs/PHASE-5.md`) — content unchanged beyond a rename
  note at the top; `apps/api/src/services/enquiryPipelineService.ts` and
  `packages/db/src/repositories/conversationRepository.ts` — two internal comments' file references
  updated to the new filename.

No working Phase 1-4 functionality was changed; `pnpm test` (full regression) re-run green on the
final commit, exit code 0.

## 12. Migration status

One new migration, `20260923134719_add_eligibility_engine` — purely additive (3 `CreateEnum` + 3
`CreateTable` + indexes/FKs), no change to any existing table or column. Verified applying cleanly,
in order, on a brand-new database (`prisma migrate deploy` against a freshly created, empty
Postgres database) alongside every prior migration; seed verified idempotent against the same fresh
database.

## 13. Next steps (proposed, not started)

Two open decisions for the user, not made unilaterally here:

1. Extend `runFullEnquiryPipeline` (the WhatsApp auto-pipeline) to call Step 5 automatically after
   Step 4 completes — would need a design decision on how/when a customer supplies age/license/
   passport/nationality over a chat channel (a new clarification-style prompt, most likely), which
   this phase deliberately did not invent without being asked.
2. Which comes next: journey Step 6 (Availability), the rest of the original id-5 channels/
   documents/payments/CRM phase, an admin endpoint for policy/exception management (pulled forward
   from Phase 7), or the real Event/Workflow Engine.

Do not start either until asked.
