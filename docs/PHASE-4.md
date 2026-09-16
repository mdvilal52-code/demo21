# Phase 4 — Ask Missing Information (journey Step 4)

Status: **FROZEN**

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`, `docs/MASTER-PLAN.md`
  (no UI changes this phase, so `docs/DESIGN-SYSTEM.md` has nothing to apply).
- Read `docs/PHASE-3.md` (previous phase) and its §13 forward contract for Phase 4.
- Inspected the repository; local PostgreSQL 16 + Redis confirmed reachable; ran the existing
  Phase 1 + Phase 2 + Phase 3 suite before changing anything (350-test baseline green).

## 2. Scope

Goal: journey Step 4 — **Ask Missing Information** — end to end: take a conversation whose Steps
1-3 (intent, dates/location, vehicle) are already complete and determine only what is _genuinely_
still missing, ask targeted typed questions for it, and loop across turns until complete — never
asking for information already supplied anywhere (Step 1's entities, an earlier Step 4 answer, or a
correction). Same AI-proposes/domain-verifies split as Steps 1-3, plus the piece those steps never
needed: this is the first genuinely stateful, multi-turn journey step.

Potential fields: flight number, hotel/drop-off address, pickup time, driver requirement, special
requests, contact details — each only required when real Step 1-3 data says it applies (e.g. a
flight number is only asked for when Step 2 actually resolved an `AIRPORT` pickup).

Input: this conversation's latest `Message.content`, but — unlike Steps 2-3 — never read directly
from the request body of the endpoint that processes it. A dedicated new endpoint
(`POST .../messages`) is how a customer reply is durably stored first; the processing endpoint
(`POST .../missing-information`) takes no body at all and always operates on whatever was last
stored, the same "never re-parse raw text at this layer" discipline Steps 2-3 established, now
applied one layer further back. Output (`MissingInformationResult` + API response): `status`
(`AWAITING_CUSTOMER`/`COMPLETE`), `missingFields`, `pendingQuestions`, `answers`, `corrections`,
`contradictions`, `flags`, `modelMetadata`.

Out of scope (deferred): the 24h idle-timeout → `EXPIRED` transition MASTER-PLAN.md §4 lists as
Step 4's side effect — that is a scheduled/timer-driven state transition, squarely the real
Event/Workflow Engine's job (`packages/workflow`, `apps/worker` per MASTER-PLAN §1), which Phase 2's
and Phase 3's own §13 notes already deferred as "still a distinct, larger phase"; nothing here
invents a workflow engine to get a timer. Also deferred, unchanged from Phases 2-3: eligibility
(Step 5), availability/holds (Step 6), the real pricing engine (Step 8), and any AI provider/LLM
integration (Phases 1-4 are all deterministic; see `docs/ARCHITECTURE.md`'s AI Intent Engine note).

## 3. Design decisions

- **Four components, one orchestrator, matching the exact split asked for.** `AnswerExtractionService`
  (pure, zero I/O) proposes answer candidates from text; `MissingFieldDetector` (pure, zero I/O) is
  the sole deterministic authority on "genuinely missing"; `QuestionPolicy` (pure, zero I/O) is the
  sole decision-maker for "what to ask next," from typed templates only; `ConversationState`
  (functional-core, immutable) is the sole place multi-turn merge/correction/contradiction logic
  lives. `MissingInformationEngine` wires all four, exactly mirroring the "AI proposes, deterministic
  domain logic verifies" split Steps 1-3 established, a fourth time.
- **A new reply endpoint, because Step 4 needs something Steps 1-3 never did: a second customer
  message.** `POST /v1/enquiries/:conversationId/messages` is the only endpoint in the API that
  accepts raw customer text for an _existing_ conversation; `POST .../missing-information` (Step 4's
  own endpoint) deliberately never does, reading the stored message instead — same convention as
  Steps 2-3's single endpoint, just split across two calls because a reply has to be durably stored
  before Step 4 can react to it, and idempotency (see below) needs that message to have a stable id.
- **Free-text fields are never scanned opportunistically.** Flight number, pickup time, driver
  requirement, and contact details are pattern-matched unconditionally — each has real, narrow
  textual evidence (a flight-code shape, an explicit am/pm or `HH:MM` time, a driver-requirement
  keyword, an email/phone shape) and nothing is ever guessed without it. Dropoff address and special
  requests cannot be pattern-matched safely, so they are _only_ captured as the answer to a field
  this same conversation asked about in an earlier turn — never on a first message, and never when
  the message already yielded other structured answers (a message clearly about a flight number and
  a driver requirement is not a plausible plain-text address). This was tightened twice during
  development after two different classes of over-eager capture were found by hand-testing adversarial
  inputs (see §9).
- **An explicit anchor phrase is tried before falling back to the whole message**, for the dropoff
  address specifically: `"drop off at …"` / `"deliver to …"` / `"address is …"` captures just the
  address out of a reply that mixes it with other information, then trims at the first sentence
  boundary or other-field pattern (email/phone/flight number) so a trailing clause in the same
  breath ("...Burj Al Arab, my number is 0501234567") never leaks into the stored address.
- **Negation-aware driver-requirement extraction.** "I don't need a driver" and "I don't want
  self-drive" both flip the naive keyword match to its opposite — checked via a small preceding-window
  regex rather than trusting the keyword alone, which would otherwise record the exact opposite of
  what the customer said (found during code review, confirmed reachable, fixed before it ever shipped).
- **At most one contact-details candidate even when a message has both an email and a phone
  number** — offering two reachable channels is not a contradiction (unlike two different flight
  numbers or opposite driver-requirement signals), and the field stores only one value; email is
  preferred as the more durable channel. Returning both as separate candidates would trip the
  generic 2-distinct-values contradiction rule and wrongly discard both.
- **Single free-text slot, with required able to bump optional — never the reverse.**
  `QuestionPolicy` never proposes a second free-text question (address/special-requests) while one is
  already pending, so a free-text reply is never ambiguous about which field it answers. If an
  optional free-text question is already pending and a later turn's fresh Step 1-3 read makes a
  _different_ free-text field newly required, the required field withdraws the optional one from the
  slot (deferred, not "asked" — it stays eligible later) rather than being permanently blocked by it.
  Found via code review as a reachable deadlock, confirmed with a dedicated regression test.
- **Idempotent replay reconstructs from persisted state, never reprocesses the message.** The
  processing endpoint takes no body, so a retried request is identical to the original by
  construction; `lastProcessedMessageId` on the persisted state is how that retry is recognized.
  Re-running `processTurn` against the _already-updated_ prior state on a retry could misread the
  original message as a reply to a question that same message only just caused to be asked — instead,
  `MissingInformationEngine.buildResultFromState` reconstructs the current view from persisted state
  alone (re-running only the cheap, pure `MissingFieldDetector.detect`), and a replay never persists,
  audits, or counts against the abuse-protection turn cap again.
- **Abuse-protection turn cap enforced by the caller, not the engine.** `MAX_MISSING_INFO_TURNS`
  (50) is checked in `missingInformationService` before `processTurn` ever runs — the engine itself
  never throws, same discipline as Steps 1-3's orchestrators.
- **Five independent tenant-scoped reads batched into one `Promise.all`.** The conversation+message,
  Step 1 intent, Step 2 dates/location, Step 3 vehicle-determined-yet, and prior Step 4 state are
  each read once per call and none depends on another's result, so they are issued together —
  raised during code review as a performance improvement (not a correctness fix) over the original
  sequential version; verified byte-for-byte behavior-identical by re-running the full test suite
  after the change.
- **Step 3's dependency check only needs to know Step 3 ran, never what it resolved** —
  `hasVehicleDeterminationForConversation` is a cheap existence `count()`, not a full row read; Step 4
  has no use for the resolved vehicle itself, only for the fact that the dependency chain (1→2→3) is
  satisfied.

## 4. What was built

- `packages/domain/src/missingInformation.ts` — `MissingInfoFieldKey` (6 fields), `MissingInfoStatus`,
  `AnswerSource`, `OPTIONAL_MISSING_INFO_FIELDS`, `FREE_TEXT_MISSING_INFO_FIELDS`, per-field value
  schemas, `missingInfoAnswerSchema` (discriminated union), `pendingQuestionSchema`,
  `correctionRecordSchema`, `contradictionRecordSchema`, `missingInformationResultSchema`,
  `conversationStateSchema`, `MAX_MISSING_INFO_TURNS`.
- `packages/ai/src/step4/` — `fieldTemplates.ts` (typed en/ar question templates),
  `fieldRequirementRules.ts` (`isFieldRequired`, the sole "is this field even applicable" authority),
  `answerExtractionService.ts` (`AnswerExtractionService`), `missingFieldDetector.ts`
  (`MissingFieldDetector`), `questionPolicy.ts` (`QuestionPolicy`), `conversationState.ts`
  (`ConversationState`), `orchestrator.ts` (`MissingInformationEngine`).
- `packages/db`: `MissingInformationState` model + `MissingInfoStatus` enum (migrations
  `20260916084950_add_missing_information_state`, `20260916091745_add_missing_info_last_processed_message`),
  `missingInformationRepository.ts` (create/find/version-checked update), conversation-scoped Step 1-3
  readers added to the existing `intentRepository.ts` / `dateLocationExtractionRepository.ts` /
  `vehicleDeterminationRepository.ts`, `appendMessageToConversation` + `findConversationWithLatestMessage`
  added to the existing `conversationRepository.ts`.
- `packages/contracts/src/missingInformation.ts`, `packages/contracts/src/conversationReply.ts` —
  request/response schemas for the two new endpoints.
- `apps/api`: `services/conversationReplyService.ts`, `routes/v1/conversationReply.ts`
  (`POST /v1/enquiries/:conversationId/messages`, `Idempotency-Key` supported),
  `services/missingInformationService.ts`, `routes/v1/missingInformation.ts`
  (`POST /v1/enquiries/:conversationId/missing-information`), `missingInformationEngine` added to
  `AppContext`.
- `packages/testing/src/db.ts` — `missing_information_states` added to the truncation list.

## 5. APIs

| Method | Path                                                | Purpose                                                                           |
| ------ | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/v1/enquiries/:conversationId/messages`            | Append a follow-up customer reply to an existing conversation (idempotent)        |
| POST   | `/v1/enquiries/:conversationId/missing-information` | Process the conversation's latest message for Step 4; persist + return the result |

Request/response schemas: `packages/contracts/src/conversationReply.ts`,
`packages/contracts/src/missingInformation.ts`; live in the OpenAPI doc at `/docs`.

## 6. Database schema

`MissingInformationState` — see `packages/db/prisma/schema.prisma` and
`packages/db/prisma/migrations/20260916084950_add_missing_information_state/` +
`packages/db/prisma/migrations/20260916091745_add_missing_info_last_processed_message/`.

- One row per conversation (`conversationId String @unique`) — unlike `IntentRecord`/
  `DateLocationExtraction`/`VehicleDetermination`'s append-only-history convention, this table holds
  the conversation's _current_ Step 4 state and is genuinely mutated turn by turn.
- `version Int @default(0)`, incremented on every update; `updateMissingInformationState` pins its
  `WHERE` clause to the version the write was computed from, so a concurrent turn for the same
  conversation loses the race with a structured `AppError('CONFLICT', ...)` rather than silently
  clobbering the other turn's answers — same optimistic-concurrency convention as elsewhere in the
  codebase.
- `answers` / `pendingQuestions` / `corrections` / `contradictions` / `flags` are `Json` columns,
  always Zod-revalidated (`conversationStateSchema.parse`) on the way out of the repository, same
  read-boundary discipline as `vehicleRepository`.
- `lastProcessedMessageId String?` — the field that makes replay detection possible; set on every
  successful turn, compared against the conversation's current latest-message id on every call.

## 7. Security decisions

**Implemented and tested:**

- **Never expose internal prompts or system instructions** — `QuestionPolicy` renders only one of a
  fixed, versioned set of typed templates (`fieldTemplates.ts`); no question text is ever generated
  from customer input or a system prompt, so there is nothing that could leak through a rendered
  question. Proven directly: a role-play/"reveal your system prompt" injection payload is flagged
  (`flags.promptInjectionDetected`) but the response never contains anything beyond the fixed template
  text.
- **Never ask for unnecessary sensitive information** — every field's requiredness is computed from
  real Step 1-3 data (`isFieldRequired`); contact details, for example, are only asked on the `WEB`
  channel (WhatsApp/Email already carry a reachable identity). PII minimization: a passport number or
  other unrelated PII mentioned in a reply is never opportunistically captured as an answer to any
  field (free text only binds to a field the conversation itself asked about), and it is never
  written to the audit trail — audit events record field/answer _counts_ only, never raw values.
- **Never hallucinate** — `MissingFieldDetector` and `QuestionPolicy` are pure/zero-I/O deterministic
  logic; `AnswerExtractionService` only ever returns a candidate with real textual evidence in the
  message (regex/keyword matched), same zero-hallucination discipline as Phase 1's intent engine.
- **Avoid repeated questions / maintain conversation state** — `askedFieldKeys` permanently marks a
  field as asked (never re-asked, even across many turns); `ConversationState.applyCandidates`
  treats a repeated identical answer as a no-op — proven by a dedicated test asserting no new
  correction/contradiction/audit-worthy change on a genuine repeat.
- **Detect user correction** — a new value for an already-answered field is recorded as a
  `CorrectionRecord` (`previousValue`/`newValue`), and the answer's `corrected: true` flag is set;
  two different values arriving in the _same_ message are a `ContradictionRecord` and neither is
  trusted (the prior answer, if any, is left untouched).
- **Multilingual responses** — question templates exist in English and Arabic
  (`SUPPORTED_QUESTION_LANGUAGES`); an unsupported language (e.g. Hindi) falls back to English rather
  than rendering nothing or throwing.
- **Prompt-injection detection** — reused Phase 1's `sanitizeForProcessing`, no new implementation;
  proven with two distinct injection payload shapes against the live HTTP endpoint.
- **Rate limiting / abuse protection** — `MAX_MISSING_INFO_TURNS` (50) enforced by
  `missingInformationService` before the engine runs; exceeding it returns a structured
  `AppError('RATE_LIMITED', ...)`. A replayed/idempotent retry never counts against the cap (proven
  by a dedicated test distinguishing a genuine new turn from a replay).
- **Session isolation** — a `MissingInformationState` is scoped to one `conversationId`; proven with
  a cross-conversation test (two conversations' Step 4 state never interfere) and a cross-tenant
  defense-in-depth test (404, not data leakage, across tenants).
- **SQL injection** — Prisma parameterized queries only; proven with a SQL-injection-shaped payload
  reaching the endpoint end to end via a stored reply message.
- **Audit events** — every Step 4 evaluation writes an `AuditEvent` (`missing_information.evaluated`)
  in the same Prisma transaction as the state write; the reply-append endpoint writes its own
  (`conversation.message_appended`) with a message-id reference only, never raw content.
- **Structured errors, no internal leakage** — a not-found conversation and a Step 1-3 precondition
  failure both return a stable `AppError` envelope; proven with tests asserting no stack trace, file
  path, or internal implementation detail reaches the response body.

**Explicitly deferred (documented, not silently skipped):**

- Database-level Row Level Security — still application-level only, unchanged from Phases 1-3.
- The 24h idle-timeout → `EXPIRED` transition MASTER-PLAN §4 lists for this step — a scheduled
  state transition that belongs to the real Event/Workflow Engine (Phase 2's and Phase 3's own §13
  notes already deferred that engine as "still a distinct, larger phase"); no ad hoc timer was
  invented here to simulate it.
- A real AI/LLM provider — Phase 4, like Phases 1-3, is fully deterministic; the `AIProvider` seam in
  `packages/ai/provider.ts` remains unused, ready for a future phase.

## 8. Test results

All commands run against real local PostgreSQL 16 + Redis (same sandbox as Phases 1-3; Docker
daemon still unavailable here).

| Gate        | Command                 | Result                                               |
| ----------- | ----------------------- | ---------------------------------------------------- |
| Typecheck   | `pnpm typecheck`        | ✅ 11/11 packages                                    |
| Lint        | `pnpm lint`             | ✅ 0 errors, 0 warnings                              |
| Format      | `pnpm format:check`     | ✅ clean                                             |
| Unit        | `pnpm test:unit`        | ✅ 375 tests (was 260 in Phase 3 — 115 new)          |
| Integration | `pnpm test:integration` | ✅ 89 tests (was 53 — 36 new)                        |
| Security    | `pnpm test:security`    | ✅ 42 tests (was 33 — 9 new)                         |
| E2E         | `pnpm test:e2e`         | ✅ 4 tests, unchanged from Phase 1-3 (no UI touched) |
| Build       | `pnpm build`            | ✅ every package + Next.js production build          |

**Total: 510 automated tests, all passing** — the full Phase 1 + Phase 2 + Phase 3 suite re-run and
green (regression requirement), plus Phase 4's new coverage. Code review (four rounds — three during
implementation, one final confirmation pass after the last fix) and an architecture review against
`MASTER-PLAN.md` §1/§4/§6 both completed with no outstanding findings.

Every explicitly required test case passes, most directly in `packages/ai/src/step4/*.test.ts` (unit,
zero I/O) and `packages/ai/src/step4/orchestrator.test.ts` (full engine, in-memory state), and again
through the live HTTP API in `apps/api/src/missingInformation.integration.test.ts` /
`missingInformation.security.test.ts`:

| Case                    | Where                                                        | Result                                                                                     |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| complete request        | orchestrator + API integration                               | `status: COMPLETE`, zero `missingFields`, no questions raised                              |
| one missing field       | orchestrator + API integration                               | `status: AWAITING_CUSTOMER`, exactly one pending question, typed template text             |
| multiple missing fields | orchestrator + API integration                               | all required fields surfaced, required before optional, single free-text slot respected    |
| contradictory answers   | `conversationState.test.ts` + orchestrator + API integration | both candidate values discarded, `ContradictionRecord` recorded, prior answer untouched    |
| repeated answers        | `conversationState.test.ts` + orchestrator + API integration | no-op — idempotent, no spurious correction/contradiction                                   |
| malicious input         | `missingInformation.security.test.ts`                        | XSS/HTML and SQL-injection-shaped payloads treated as inert text, no crash, no data loss   |
| prompt injection        | `missingInformation.security.test.ts`                        | `flags.promptInjectionDetected`, never grants what the payload asks for                    |
| PII attack              | `missingInformation.security.test.ts`                        | a passport number is never captured as an answer to any field, never reaches the audit log |
| session isolation       | `missingInformation.integration.test.ts`                     | cross-conversation and cross-tenant isolation both proven, defense-in-depth 404            |

## 9. Known limitations

- **Extraction is regex/keyword based, not true NLP** — same class of heuristic as Phases 1-3;
  phrasing outside the covered patterns correctly leaves a field missing (asked about again) rather
  than guessed, but isn't specifically resolved.
- **Free-text capture was tightened twice during development** after adversarial hand-testing found
  two distinct over-eager-capture failure modes: (1) an early version captured _any_ message as the
  answer to the sole pending free-text field, even on turn 1 with no prior question context; (2) after
  fixing that, an unrelated message could still be captured once a free-text field became the sole
  pending question. Both are now guarded (never opportunistic before a field was actually asked about;
  never captured unanchored when the message already yielded other structured answers) and covered by
  regression tests (`answerExtractionService.test.ts`).
- **The 24h idle-timeout → `EXPIRED` transition is not implemented** — see §3/§7; it requires the real
  Event/Workflow Engine (a scheduled/timer-driven state transition), deferred consistently with
  Phases 2-3's own notes on that engine.
- **`MAX_MISSING_INFO_TURNS` (50) is a fixed constant**, not a per-tenant configurable — sufficient for
  this phase's abuse-protection requirement; making it tenant-configurable is additive, not an
  architecture change, if ever needed.
- **No fleet/pricing/availability logic here** — unchanged scope boundary from Phase 3; this phase
  only ever reads Step 3's completion flag, never its resolved vehicle.
- **Full `prisma migrate reset` (destructive up/down/up replay) was not performed** — same Prisma
  AI-safety-guard rationale as Phases 1-3; migration cleanliness was demonstrated via sequential
  `migrate dev` (dev DB) / `migrate deploy` (test DB) applies instead.
- **No Docker daemon in this dev sandbox** (same as Phases 1-3) — `docker-compose.yml` unaffected and
  correct for normal local/CI use.

## 10. Files created

- `packages/domain/src/missingInformation.ts` (+ `.test.ts`)
- `packages/ai/src/step4/*.ts` and matching `*.test.ts` (fieldTemplates, fieldRequirementRules,
  answerExtractionService, missingFieldDetector, questionPolicy, conversationState, orchestrator)
- `packages/db/prisma/migrations/20260916084950_add_missing_information_state/migration.sql`
- `packages/db/prisma/migrations/20260916091745_add_missing_info_last_processed_message/migration.sql`
- `packages/db/src/repositories/missingInformationRepository.ts` (+ `.test.ts`)
- `packages/contracts/src/missingInformation.ts` (+ `.test.ts`)
- `packages/contracts/src/conversationReply.ts` (+ `.test.ts`)
- `apps/api/src/services/conversationReplyService.ts`
- `apps/api/src/services/missingInformationService.ts`
- `apps/api/src/routes/v1/conversationReply.ts`
- `apps/api/src/routes/v1/missingInformation.ts`
- `apps/api/src/conversationReply.integration.test.ts`
- `apps/api/src/missingInformation.integration.test.ts`, `apps/api/src/missingInformation.security.test.ts`
- `docs/PHASE-4.md` (this file)

## 11. Files modified

- `packages/ai/src/index.ts`, `packages/domain/src/index.ts`, `packages/contracts/src/index.ts`,
  `packages/db/src/index.ts` — new exports added.
- `packages/db/prisma/schema.prisma` — added `MissingInformationState` model and its enum, relations
  from `Tenant`/`Conversation`.
- `packages/db/src/repositories/intentRepository.ts`,
  `packages/db/src/repositories/dateLocationExtractionRepository.ts`,
  `packages/db/src/repositories/vehicleDeterminationRepository.ts` — conversation-scoped readers added.
- `packages/db/src/repositories/conversationRepository.ts` — `appendMessageToConversation` +
  `findConversationWithLatestMessage` added.
- `packages/testing/src/db.ts` — `missing_information_states` added to `TABLES`.
- `apps/api/src/context.ts`, `apps/api/src/server.ts`, `apps/api/src/test/buildTestApp.ts`,
  `apps/api/src/app.ts` — `missingInformationEngine` wired into `AppContext`; two new routes
  registered.
- `packages/ai/src/provider.ts`, `packages/ai/src/sanitize.ts` — stale "wired up in Phase 4" /
  "Phase 4 (a real LLM...)" comments corrected: Phase 4 turned out deterministic like Phases 1-3, so
  a real LLM/AIProvider integration remains a distinct, not-yet-numbered future phase.
- `docs/ARCHITECTURE.md`, `docs/PHASE-CONTRACTS.json` — updated for Phase 4 (new flow section, data
  model, security posture table, monorepo layout; id-4 reconciled from the stale "AI Orchestrator &
  Provider Abstraction" placeholder to this phase's real content, per the `phaseNumbering` note's
  documented precedent).

No working Phase 1/2/3 functionality was changed; no dead code was found to remove.

## 12. Migration status

Two new migrations applied and verified on both dev and test databases:
`20260916084950_add_missing_information_state` and `20260916091745_add_missing_info_last_processed_message`
(forward migration path exercised via `prisma migrate dev` / `prisma migrate deploy`, same convention
as Phases 1-3). See Known Limitations for why a full destructive reset-and-replay was not additionally
performed.

## 13. Phase 5 contract (proposed inputs for the next phase)

Per `MASTER-PLAN.md` §4, journey Step 5 is **Eligibility** (`ELIGIBILITY_CHECK`, owner `SYS`): tenant
rules — minimum age per vehicle class, licence type (UAE / IDP), residency, blocklist, deposit
ability — failing which the journey moves to `DECLINED` with a reason, or may escalate to a T3
manager for an exception. Per `PHASE-CONTRACTS.json`'s `phaseNumbering` note, the document's current
phase-id-5 entry ("Channels, Documents, Payments, CRM & Fulfilment") is still the original 10-phase
placeholder, not yet reconciled with the journey-step numbering Phases 1-4 have actually followed —
the same situation this phase resolved for its own id-4 entry. Should build on:

- `IntentRecord` (Step 1), `DateLocationExtraction` (Step 2), `VehicleDetermination` (Step 3), and
  `MissingInformationState` (Step 4, once `status: COMPLETE`) are now all independently queryable
  per-conversation; Step 5 reads them the same tenant-scoped way to evaluate eligibility against the
  now-complete booking shape.
- Reuse the "AI proposes, deterministic domain logic verifies" split and the `*ResultSchema`-style
  pattern (always Zod-validate the final result) a fifth time, where an AI-facing proposal step makes
  sense — eligibility itself, per MASTER-PLAN, is owner `SYS` (purely deterministic rules), so this
  may end up being the first step with no AI-proposes half at all, which is fine and expected, not a
  deviation to correct.
- Do not build the real Event/Workflow Engine (journey state machine) or the 24h missing-info timeout
  it would enable — still a distinct, larger phase per `MASTER-PLAN.md`, unchanged from Phases 2-4's
  notes.
- Do not build a real AI/LLM provider integration — still deferred, unchanged from Phases 1-4's notes;
  the `AIProvider` seam in `packages/ai/provider.ts` remains ready whenever that phase is scoped.

Do not start Phase 5 until asked.
