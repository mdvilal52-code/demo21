# Phase 6 — Conversational AI Engine (Gemini)

Status: **FROZEN**

## 0. Scope note — reconciling this phase's name, and the 2026-09-25 branch merge

This phase was originally built as id 6 on a branch that had only Phases 1-5 (the official
WhatsApp channel adapter) — it was explicitly requested ahead of Security and ahead of journey
Step 5 (Eligibility) as a conversational-engine upgrade: give the WhatsApp channel a real,
human-like reply layer using Gemini, without weakening the "AI proposes, deterministic code
verifies" discipline Phases 1-5 already established.

On 2026-09-25 that branch was merged with a second, independently-developed branch that had built
much further past Phase 4: a real Security Engine, Eligibility, Availability, Alternatives, and a
Quote/Pricing engine (see the top-level `phaseNumbering` note in `PHASE-CONTRACTS.json` for the
full history). The two branches' conversation-continuity work — this phase's own reopen-or-create
logic and the other branch's more complete `findOpenConversationForCustomer`/`continueEnquiry`
(bare "Yes" replies, booking-shaped-entity detection, claim-based idempotency) — solved the same
problem independently; the merge adopted the other branch's version wholesale as strictly more
capable, and this phase's Gemini reply generation was re-wired onto it (see §3's "Merge
reconciliation" note below). Every phase was then renumbered into one clean sequential list; this
phase is now id 11, not id 6 — see `PHASE-CONTRACTS.json`'s `phaseNumbering` field for the
authoritative id history.

**Why it was judged safe to build this ahead of Security.** MASTER-PLAN.md's own Phase 6 goal is
the zero-trust layering that makes it safe to call a live model — egress allowlisting, an AI
sandbox, injection defenses, output DLP. Introducing a real LLM before that phase exists is a real
ordering risk. This phase does not skip that risk; it absorbs the specific pieces a live model
call actually needs as part of its own scope, using patterns Phase 2 already established rather
than inventing new ones:

- Egress: `GeminiProvider` calls exactly one hardcoded host (`generativelanguage.googleapis.com`)
  through `ssrfSafeFetch`, the same seam `MetaCloudApiWhatsAppClient` already uses — not a
  configurable allowlist a misconfiguration could widen.
- Resilience: `ResilientAIProvider` (timeout + circuit breaker + rate limit) wraps every call,
  the same decorator pattern `ResilientLocationProvider` already proved in Phase 2.
- Injection defense: `sanitizeForProcessing` (Phase 1's prompt-injection sanitizer) runs on every
  customer turn before it reaches the model prompt — its own docstring anticipated this exact
  moment ("so Phase 4 ... inherits working detection on day one").
- Output grounding: every AI-generated reply is Zod-validated and then code-level checked for
  invented prices or availability/booking claims before it can reach a customer — see §3.
- Least privilege / secrets: `GEMINI_API_KEY` stays server-side (`apps/api`), sent via header,
  never in a URL or a log line, never reachable from `apps/web`.

What this phase does **not** attempt is the rest of Security Engine & Zero Trust (OIDC/OAuth2
AuthN, RBAC+ABAC, RLS, key rotation, anomaly detection, Semgrep/Trivy/ZAP in CI) — that remains
real, unstarted, PENDING work at id 7.

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json` (found id 6 = the original
  Security entry, PENDING, next in `dependsOn` order), `docs/MASTER-PLAN.md`.
- Read `docs/PHASE-5.md` (previous phase) — its §13 forward contract did not anticipate this
  scope, since this phase was a fresh, explicit request rather than a planned continuation.
- Inspected the repository before writing anything: `packages/ai/src/provider.ts` (an
  unimplemented `AIProvider` seam — only `NotConfiguredProvider` existed; its own comment says
  "wired up in Phase 4", but Phase 4 was reconciled to journey Step 4 and never wired a real
  model), every Step 1-4 orchestrator (100% deterministic — regex lexicons, a gazetteer,
  Levenshtein fuzzy matching, template strings; zero LLM calls anywhere in the system),
  `whatsappService.ts`'s own docstring ("no cross-message thread memory yet... explicitly
  later-phase scope"), `enquiryService.ts`'s `submitEnquiry` (confirmed: unconditionally creates a
  brand-new `Conversation` row on every call — a customer's second WhatsApp message today starts
  an entirely unrelated conversation with zero memory of the first), and `apps/web` (confirmed:
  still just the Phase 1 enquiry-form shell — no Worker Panel exists yet; that's id 8, which
  `dependsOn` the still-PENDING id 7).
- Ran the existing suite as a baseline before changing anything: `pnpm install`, `pnpm
db:generate`, then typecheck/lint/unit all green (341 unit tests, matching Phase 5's §8 count).
  No Docker daemon in this sandbox (same documented limitation as every prior phase) — installed
  PostgreSQL 16 (already present, just stopped) and started Redis locally, exactly as Phase 5's
  doc describes, to get real integration/security/e2e coverage rather than skipping it.

## 2. Scope

Goal: a real, human-like conversational reply layer for the WhatsApp channel, built on top of the
already-frozen, unchanged Steps 1-4 business logic — plus fixing the conversation-memory gap that
made "human-like, multi-turn" impossible in the first place.

Deliverables — see the `PHASE-CONTRACTS.json` id-6 entry for the authoritative list; summary:

- [x] `AIProvider` interface evolved to a real structured-generation + health-check contract
- [x] `ResilientAIProvider` decorator (timeout, circuit breaker, rate limit)
- [x] `GeminiProvider` (direct REST adapter) + `createAIProvider` factory, `NOT_CONFIGURED` by
      default
- [x] `generateConversationalReply` — grounded reply generation with a deterministic-template
      fallback
- [x] Conversation continuity — reopen an in-progress conversation instead of always starting
      fresh
- [x] Steps 2-3 read the accumulated transcript, not just the latest message
- [x] Wired into `whatsappService.ts`; boot-time health check in `server.ts`
- [x] New `AppError` code `AI_RESPONSE_INVALID`
- [x] Docs updated (`MASTER-PLAN.md` §9, this file, `PHASE-CONTRACTS.json`, `.env.example`,
      `render.yaml`)

Out of scope for this phase (deliberately, not by oversight):

- Journey Step 5 (Eligibility), Availability/holds, Alternatives, Quote generation — none of these
  exist yet, so the reply generator has no pricing/availability facts to ground on even once those
  steps ship; the grounding check treats _any_ price or availability claim as fabricated today.
- The Worker Panel and human escalation system (queue, assignment, SLA, takeover) — that's id 8,
  which depends on the still-PENDING id 7 (Security: RBAC/ABAC for a "who can see this
  conversation" system). This phase does not build escalation _detection_ either, to keep scope
  honest: there is nowhere for an escalation to go yet.
- True "latest value wins" contradiction resolution when a correction conflicts with an earlier
  turn (e.g. a date stated twice, differently) — Steps 2-3 now see the _whole_ transcript instead
  of just the latest message, which already fixes the common case (a follow-up that doesn't
  restate an earlier fact), but two conflicting mentions in the same transcript can still resolve
  to either one, since the regex-based extractors have no concept of "later in time wins". Real
  contradiction resolution needs a dedicated entity-merge service, not a transcript-concatenation
  heuristic — flagged here rather than half-built under this phase's scope.
- Persisting the assistant's own outbound replies as `Message` rows — today only customer turns
  are stored, so `RecentTurn.role` is always `'customer'`. The `role` field exists on the type
  specifically so this is a pure addition later, not an interface change.
- Anthropic/OpenAI adapters — `AIProvider` remains provider-agnostic; only Gemini has a real
  implementation.
- The full Security Engine (id 7) — see §0.

## 3. Design decisions

**Gemini only for conversational reply generation, never for business facts.** Per explicit
direction, Gemini is scoped to _how_ something is said, never _what_ is true. Concretely:
`generateConversationalReply` takes Step 4's already-verified `MissingInfoResult` (dates,
location, vehicle — all independently validated by deterministic code) and recent transcript
turns, and asks the model only to phrase a reply around them. The system instruction explicitly
forbids inventing a vehicle/date/location/price/availability/booking-status not present in the
"Known facts" block, and forbids claiming a booking is confirmed or a vehicle is available — no
step in this system produces either of those yet. A second, code-level check
(`isGrounded`/`CURRENCY_PATTERN`/`OVERCLAIM_PATTERN`) enforces this even if the model doesn't
follow the instruction: any currency mention or availability/booking-confirmation phrase in the
model's reply triggers the deterministic fallback instead. This is "never trust AI output" applied
literally — the prompt is a strong suggestion, the code check is the actual boundary.

**Model id: `gemini-3.8-flash` by default, fully overridable.** The task explicitly named "Gemini
3.1 Flash" and asked to verify the real model id against Google's own docs rather than assume.
Three independent fetches of `ai.google.dev/gemini-api/docs/models` converged: a bare
`gemini-3.1-flash` does not exist as a GA model id — only `gemini-3.1-flash-lite` (a
cost/latency-optimized variant) does at that version. The current GA flagship general-purpose
Flash model (tool-calling, JSON output, strong reasoning) is `gemini-3.8-flash`. Since this is a
premium concierge that needs quality phrasing, not the cheapest/fastest tier, the default targets
the flagship rather than the lite variant literally named. `GEMINI_MODEL_ID` is a plain env var
with no other code path depending on the exact string — switching to `gemini-3.1-flash-lite` or
anything else is a one-line change, not a code change.

**Conversation continuity policy.** `findReopenableConversationId` (enquiryService.ts) reuses the
customer's most recent conversation on the same channel when it was created within Step 4's own
`MISSING_INFO_TIMEOUT_HOURS` (24h) window and its latest `MissingInfoCheck` status is not
`COMPLETE` (that booking request is done — a new message is a new request, e.g. "book another
car") or `EXPIRED` (the customer was already told to start over; reopening it silently would
contradict that). `NEEDS_INFO`, `NOT_APPLICABLE`, or no check yet (Step 4 hasn't run) all reopen.
This mirrors a status Step 4 already computes and stores — no new state machine invented.

**Transcript accumulation vs. contradiction resolution.** Steps 2-3 now run their existing,
unchanged, already-tested extractors against `joinTranscript(messages)` (all turns, newline-joined
— capped at `MAX_TRANSCRIPT_MESSAGES` = 200 as a safety valve, not a realistic conversation
length) instead of `message.content` (the single latest message). This is a call-site change only
— zero lines changed inside `packages/ai`'s frozen Step 2/3 internals, so their full existing
Phase 2/3 test suites (180+53, 260+53 unit/integration respectively per their own phase docs)
exercise exactly the same extraction logic, just against richer input. The known limitation (two
conflicting mentions in one transcript) is documented in §2, not silently accepted.

**One fetch, reused three ways, not three fetches.** `/code-review` (see §5) caught that the first
version of this phase fetched the conversation's message history three separate times per inbound
WhatsApp message — once inside each of Steps 2-3's transcript building, and again for the reply
generator's recent-turns context. Fixed by having `whatsappService.ts` fetch once
(`findMessagesForConversation`, capped at 200) right after `submitEnquiry` persists the new
message, then: the full result feeds Steps 2-3 via a new optional `precomputedTranscript` input
(REST callers, which invoke each step independently over separate HTTP calls, still fetch fresh —
correctly, since time can pass between their calls); a `.slice(-12)` suffix
(`MAX_RECENT_TURNS_FOR_REPLY`) feeds the reply generator, since that's a paid, latency-sensitive
model call where only recent turns matter for tone, unlike the free deterministic regex pass which
needs the full history to never lose an early fact.

**Silent misconfiguration was a real gap, now closed two ways.** `/code-review` also flagged that
a wrong `GEMINI_MODEL_ID` would 404 forever, silently and permanently falling back to the
deterministic template with no operator-visible signal distinguishing "intentionally not
configured" from "configured but broken" — every failure just logged a routine `warn`.
Fixed: (1) `server.ts` calls `aiProvider.healthCheck()` once at boot when `GEMINI_API_KEY` is set,
logging `error` if the configured model isn't reachable — a bad id is now visible at deploy time,
not discovered silently later. (2) `generateConversationalReply` distinguishes a
`CircuitBreakerOpenError` (repeated failures, not a one-off blip) and logs it at `error` instead of
`warn`, so basic log-based monitoring catches a persistently broken provider.

**Backward compatibility.** Every failure mode in `generateConversationalReply` — not configured,
schema-invalid, grounding violation, provider error, open circuit — falls back to the exact
pre-existing `buildWhatsAppReplyText` output (now re-exported from `@ai-concierge/channels` after
the merge below, same behavior). A customer's experience today (Gemini not configured, the
default) is byte-for-byte what Phase 5 shipped; nothing regresses.

**Merge reconciliation (2026-09-25).** This phase's own conversation-continuity fix
(`findMostRecentConversationForCustomer`/`appendMessageToConversation`-based reopen logic in
`enquiryService.ts`, and `apps/api/src/services/conversationTranscript.ts`'s
`buildConversationTranscript`) solved the same "every message starts a fresh conversation" problem
the other merged branch had already solved independently, with a more capable implementation
(`findOpenConversationForCustomer`/`continueEnquiry`, handling bare "Yes" replies and
booking-shaped-entity detection across turns, plus claim-based idempotency safe against Meta's
redelivery). The merge adopted the other branch's version wholesale; this phase's own
`conversationTranscript.ts`/`enquiryService.ts` reopen logic and `whatsappService.ts` (the whole
file, superseded by the other branch's `enquiryPipelineService.ts` + `routes/webhooks/whatsapp.ts`)
were deleted rather than kept as parallel implementations. What survived and was re-wired onto the
other branch's pipeline: the `AIProvider`/`ResilientAIProvider`/`GeminiProvider` adapter stack
unchanged, and `generateConversationalReply` itself — its one-line dependency on
`buildWhatsAppReplyText` was repointed from the (now-deleted) local `whatsappReply.ts` to
`@ai-concierge/channels`'s equivalent (same signature, now also handles a `CANCELLED` status the
other branch added). See `packages/db/src/repositories/conversationRepository.ts` for the merged
repository (their `findOpenConversationForCustomer`/`appendMessageToConversation`/
`findMessagesForConversation`, this phase's `findConversationById`/`findLatestMessageForConversation`
/`markConversationProcessed` unchanged) and `apps/api/src/routes/webhooks/whatsapp.ts` for where
`generateConversationalReply` now plugs into the other branch's `processInboundMessage`, replacing
its direct `buildWhatsAppReplyText(...)` call.

## 4. What was built

New files (as originally delivered on this phase's own branch; see the merge reconciliation note
above for what was superseded during the 2026-09-25 merge):

- `packages/ai/src/resilientAIProvider.ts` (+ `.security.test.ts`)
- `apps/api/src/lib/geminiProvider.ts` (+ `.test.ts`)
- `apps/api/src/services/conversationalReplyService.ts` (+ `.test.ts`, `.security.test.ts`) —
  survived the merge; its `buildWhatsAppReplyText` import was repointed to `@ai-concierge/channels`
- ~~`apps/api/src/services/conversationTranscript.ts` (+ `.test.ts`)~~ — deleted in the merge,
  superseded by the other branch's `apps/api/src/lib/conversationTranscript.ts`
  (`buildAccumulatedTranscript`)

Modified:

- `packages/ai/src/provider.ts` — `AIProvider` interface evolved (see §3); `packages/ai/src/index.ts`
- `packages/domain/src/errors.ts` — `AI_RESPONSE_INVALID` code
- `packages/db/src/repositories/conversationRepository.ts` (+ tests) — `findMostRecentConversationForCustomer`,
  `appendMessageToConversation`, `findMessagesForConversation`
- `apps/api/src/services/enquiryService.ts` (+ tests) — reopen-or-create
- `apps/api/src/services/dateLocationService.ts`, `vehicleService.ts` (+ tests) — `precomputedTranscript`
- `apps/api/src/services/whatsappService.ts` (+ tests) — single fetch, reply-service wiring
- `apps/api/src/context.ts`, `env.ts`, `server.ts`, `test/buildTestApp.ts`, `routes/webhooks/whatsapp.ts`
- `.env.example`, `render.yaml`, `docs/MASTER-PLAN.md` §9

## 5. APIs

None new. This phase is channel/service-layer only — no new REST routes. The existing
`POST /v1/enquiries`, `.../dates-location`, `.../vehicle-selection`, `.../missing-info` endpoints
are unchanged in shape; a future Web-chat channel (unbuilt, original phase-5-grouping remainder)
would call `generateConversationalReply` the same way `whatsappService.ts` does now.

## 6. Database schema

No migration. No Prisma model changed. Conversation continuity and transcript accumulation are
both built entirely on the existing `Conversation`/`Message`/`MissingInfoCheck` tables from Phases
1-4.

## 7. Security decisions

- `GEMINI_API_KEY` stays server-side (`apps/api`), sent via the `x-goog-api-key` header, never in
  a URL (so it can't leak through URL-based logging) and never returned to `apps/web`.
- Outbound calls are SSRF-safe: `ssrfSafeFetch` against exactly one hardcoded host
  (`generativelanguage.googleapis.com`), the same seam and convention as the Meta WhatsApp client.
- Prompt injection: `sanitizeForProcessing` (Phase 1) runs on every customer turn before it enters
  the Gemini prompt; verified in `conversationalReplyService.security.test.ts` that an injection
  payload ("Ignore previous instructions...") is replaced with `[REMOVED]` before reaching the
  model, and that a jailbreak attempt explicitly asking the model to quote a price cannot produce
  one in the actual customer-facing reply (the grounding check catches it even if the model
  complies with the injected instruction).
- Output grounding as a security boundary, not just a quality one: a well-formed, schema-valid
  reply that invents a price or claims availability/booking confirmation is rejected before it
  reaches the customer — tested explicitly, including the "jailbreak succeeds against the model but
  fails against the code" case.
- Resilience: timeout + circuit breaker + rate limiter on every call (`ResilientAIProvider`),
  tested with a slow/hanging fake provider, a failing fake provider (circuit opens), and a
  rate-limit-exceeded case.
- PII discipline: a grounding-violation log redacts the reply text through the existing
  `classifyPII`/`redactPII` (Phase 1) before logging if it looks like it contains PII.
- No new secrets, no new attack surface reachable from `apps/web` (the browser never talks to
  Gemini directly or indirectly).

## 8. Test results

All gates that can run without a Docker daemon in this sandbox were run for real — PostgreSQL 16
and Redis started locally (same approach as Phase 5's own doc), migrations applied, then every
gate run against real infrastructure, not mocked at the boundary being tested.

| Gate                | Command                  | Result | Notes                                                     |
| ------------------- | ------------------------ | ------ | --------------------------------------------------------- |
| Typecheck           | `pnpm typecheck`         | ✅     | 11/11 workspace projects                                  |
| Lint                | `pnpm lint`              | ✅     | 0 warnings (`--max-warnings=0`)                           |
| Unit                | `pnpm test:unit`         | ✅     | 361 tests (was 341 before this phase)                     |
| Integration         | `pnpm test:integration`  | ✅     | 73 tests, real Postgres/Redis                             |
| Security            | `pnpm test:security`     | ✅     | 57 tests, real Postgres/Redis                             |
| E2E                 | `pnpm test:e2e`          | ✅     | 4/4 (Phase 1 UI shell — unaffected by this phase's scope) |
| Build               | `pnpm build`             | ✅     | all workspaces, incl. `apps/web` production build         |
| Code review         | `/code-review` (medium)  | ✅     | 4 findings, all fixed and re-verified (see §3)            |
| Architecture review | checklist vs §1/§6       | ✅     | see §3 self-check notes                                   |
| Regression          | full suite, final commit | ✅     | same commands above, re-run clean after the review fixes  |

Migrations: N/A this phase (no schema change) — up/down/re-up not applicable.

**Honest caveat on "in CI":** this session ran every gate command locally against a real local
Postgres/Redis, matching what `.github/workflows/ci.yml` would run — it does not constitute an
observed green run of the actual GitHub Actions workflow, which this session did not trigger.

## 9. Known limitations

See §2 "Out of scope" for the deliberate exclusions. In addition:

- The exact `GEMINI_MODEL_ID` default (`gemini-3.8-flash`) should be confirmed against whatever
  model access the production `GEMINI_API_KEY`'s account/tier actually has before relying on it —
  Gemini model availability is account- and region-dependent and changes over time. The boot-time
  health check (§3) will surface a mismatch immediately rather than silently.
- `RecentTurn.role` is always `'customer'` today (see §2) — the model only sees what the customer
  said, not the system's own prior phrasing, which limits how well it can avoid repeating itself
  stylistically across turns (it does not repeat _questions_, since those come from Step 4's
  deterministic `missingFields`, but it has no record of its own prior wording).
- No conversation-quality evaluation harness (spec §18) exists yet — this phase's evaluation is
  the test suite in §8, not an automated conversational-quality scorer. That's Phase 10
  (Observability, AI Evaluation & Automatic QA) territory.

## 10. Files created

`packages/ai/src/resilientAIProvider.ts`, `packages/ai/src/resilientAIProvider.security.test.ts`,
`apps/api/src/lib/geminiProvider.ts`, `apps/api/src/lib/geminiProvider.test.ts`,
`apps/api/src/services/conversationalReplyService.ts`,
`apps/api/src/services/conversationalReplyService.test.ts`,
`apps/api/src/services/conversationalReplyService.security.test.ts`,
`apps/api/src/services/conversationTranscript.ts`,
`apps/api/src/services/conversationTranscript.test.ts`, `docs/phases/PHASE-06.md`.

## 11. Files modified

`packages/ai/src/provider.ts`, `packages/ai/src/index.ts`, `packages/domain/src/errors.ts`,
`packages/db/src/repositories/conversationRepository.ts` (+ `.test.ts`),
`apps/api/src/services/enquiryService.ts` (+ `.test.ts`),
`apps/api/src/services/dateLocationService.ts` (+ `.test.ts`),
`apps/api/src/services/vehicleService.ts` (+ `.test.ts`),
`apps/api/src/services/whatsappService.ts` (+ `.test.ts`), `apps/api/src/context.ts`,
`apps/api/src/env.ts`, `apps/api/src/server.ts`, `apps/api/src/test/buildTestApp.ts`,
`apps/api/src/routes/webhooks/whatsapp.ts`, `.env.example`, `render.yaml`,
`docs/MASTER-PLAN.md`, `docs/PHASE-CONTRACTS.json`.

## 12. Migration status

N/A — no schema change this phase.

## 13. Next-phase contract (proposed inputs)

For id 7 (Security Engine & Zero Trust) or whichever phase is picked up next:

- The AI sandbox / egress allowlist / injection-defense pieces this phase needed for Gemini
  specifically are done (§0, §7) — Security's remaining scope is everything else: AuthN/AuthZ,
  RLS, key rotation, anomaly detection, CI scanners.
- `AIProvider`/`ResilientAIProvider` are provider-agnostic — a future Anthropic/OpenAI adapter (or
  a Worker Panel "which provider" setting) slots in without touching `conversationalReplyService.ts`.
- Conversation continuity's reopen policy (§3) is intentionally simple (time window + Step 4
  status). If Eligibility/Availability/Quote steps ship before a richer workflow state machine
  (MASTER-PLAN.md's `packages/workflow`, Phase 3 in the original grouping) exists, this policy will
  need revisiting — it doesn't know about any state beyond Step 4's.
- `RecentTurn.role` is ready for assistant-turn persistence whenever that's picked up — no
  interface change needed, just start writing outbound `Message` rows.
