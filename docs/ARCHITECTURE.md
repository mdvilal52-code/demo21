# Architecture — as built

This documents what actually exists in the repository today. `docs/MASTER-PLAN.md` is the
long-term target across all 10 phases; this file is updated at the end of every phase to reflect
reality. See `docs/PHASE-CONTRACTS.json` for per-phase status.

## Phase 1 scope: Enquiry / Intent Recognition

```
Browser ── POST /api/enquiries (Next.js Route Handler) ── SSRF-safe fetch ──▶ Fastify API
                                                                                   │
                                                                POST /v1/enquiries │
                                                                                   ▼
                                                  ┌─────────────────────────────────────────┐
                                                  │            enquiryService                │
                                                  │  1. check Idempotency-Key (replay if hit)│
                                                  │  2. RuleBasedIntentEngine.recognize()    │
                                                  │  3. one Prisma transaction:              │
                                                  │       create Conversation + Message      │
                                                  │       create IntentRecord                │
                                                  │       write AuditEvent                   │
                                                  │       save IdempotencyKey (if provided)  │
                                                  │  4. enqueue BullMQ job (best-effort)      │
                                                  └───────────────────┬───────────────────────┘
                                                                      │
                                                                      ▼
                                                          Redis (BullMQ queue)
                                                                      │
                                                                      ▼
                                                        apps/worker consumes the job,
                                                        marks conversation.processedAt,
                                                        writes a second AuditEvent
```

## Phase 2 scope: Extract Dates & Location (journey Step 2)

Input is a Phase 1 conversation's latest message (already validated + intent-recognized) —
this step never accepts raw text directly from a request body.

```
POST /v1/enquiries/:conversationId/dates-location
                │
                ▼
  findLatestMessageForConversation (tenant-scoped)
                │
                ▼
  DateLocationExtractionOrchestrator.extract(message.content)
                │
                ├─ sanitizeForProcessing()            — prompt-injection screen (reused from Phase 1)
                │
                ├─ LocationExtractionService.extract() ── ResilientLocationProvider ── GazetteerLocationProvider
                │      (AI proposes: pickup/dropoff candidates, by reading order)      (Dubai/UAE, zero network)
                │
                ├─ DateExtractionService.extract()
                │      (AI proposes: pickup/return dates — never guesses an ambiguous one)
                │
                └─ TemporalValidationService.validate()
                       (deterministic verifier: past-date / return-before-pickup /
                        impossible-date / timezone-mismatch / unsupported-location checks,
                        confidence scoring, always Zod-validated before it leaves here)
                │
                ▼
  one Prisma transaction: create DateLocationExtraction + write AuditEvent
                │
                ▼
  201 { conversationId, messageId, extraction }
```

**AI proposes, deterministic domain logic verifies** — the same split Phase 1 established for
intent recognition, made explicit here as three separate classes: `DateExtractionService` and
`LocationExtractionService` are the proposal layer (regex/gazetteer based, same zero-hallucination
design as Phase 1's engine); `TemporalValidationService` is the sole authority on whether the
proposal is usable, and its output is what gets persisted and returned — never the raw proposal.

## Phase 3 scope: Determine Vehicle (journey Step 3)

Same input convention as Step 2 — a conversation's latest message, never raw request-body text.

```
POST /v1/enquiries/:conversationId/vehicle-selection
                │
                ▼
  findLatestMessageForConversation (tenant-scoped)
                │
                ▼
  VehicleDeterminationOrchestrator.determine(message.content, { tenantId })
                │
                ├─ sanitizeForProcessing()          — prompt-injection screen (reused from Phase 1)
                │
                ├─ VehicleCatalogService.getLexicon(tenantId) ── PrismaVehicleCatalogProvider
                │      (real fleet, tenant-scoped — never a hardcoded make/model list)
                │
                ├─ VehicleIntentService.propose(text, lexicon)
                │      (AI proposes: exact model > brand only > category only > fuzzy typo,
                │       pure/zero-I/O — only ever proposes ids present in the real lexicon)
                │
                ├─ VehicleCatalogService.resolve(tenantId, proposal)
                │      (fetches full records for the proposal's candidates + real, bookable
                │       alternatives — widening to the general fleet if a category-scoped
                │       alternative search comes up empty)
                │
                └─ VehicleValidationService.validate()
                       (deterministic verifier: resolves / needs clarification / unsupported —
                        UNKNOWN_VEHICLE, VEHICLE_INACTIVE, VEHICLE_UNAVAILABLE — confidence
                        scoring, always Zod-validated before it leaves here)
                │
                ▼
  one Prisma transaction: create VehicleDetermination + write AuditEvent
                │
                ▼
  201 { conversationId, messageId, determination }
```

**Database is authoritative; AI proposes, deterministic domain logic verifies** — the same split,
now with an explicit third component: `VehicleCatalogService` is the only class that touches the
real fleet, so "never invent inventory" is enforced structurally rather than by convention.

## Phase 4 scope: Ask Missing Information (journey Step 4)

No new "AI proposes" step this phase — everything here reads what Steps 1-3 already resolved.

```
POST /v1/enquiries/:conversationId/missing-info
                │
                ▼
  findConversationById + findLatestMessageForConversation (tenant-scoped)
                │
                ▼
  fetch the message's latest IntentRecord / DateLocationExtraction /
  VehicleDetermination in parallel (any or all may not exist yet)
                │
                ▼
  MissingInfoOrchestrator.evaluate({ intent, dateLocation, vehicle,
                                      conversationCreatedAt, now })
                │
                ├─ RequiredFieldsEvaluator.evaluate()
                │      (deterministic, zero I/O: PICKUP_DATE / RETURN_DATE / PICKUP_LOCATION /
                │       VEHICLE each present, or missing with reason NOT_PROVIDED / AMBIGUOUS /
                │       INVALID; NOT_APPLICABLE for a non-booking intent; EXPIRED past 24h)
                │
                └─ buildClarificationPrompt()
                       (deterministic template, one combined question — only when NEEDS_INFO)
                │
                ▼
  one Prisma transaction: create MissingInfoCheck + write AuditEvent
                │
                ▼
  201 { conversationId, messageId, missingInfo }
```

**Reads verified state, never re-parses raw text** — Steps 1-3 already did the work of turning
customer text into trusted, deterministically-verified fields; Step 4's only job is to look at what
exists (or doesn't) across all three and decide what's still needed, so it cannot itself introduce a
hallucinated value.

## Phase 5 (in progress) scope: WhatsApp Channel + Automated Step 1-4 Pipeline

The first slice of the original "Channels, Documents, Payments, CRM & Fulfilment" phase
(`PHASE-CONTRACTS.json` id 5): a real WhatsApp (Meta Cloud API) inbound/outbound adapter, plus a
fixed-sequence pipeline that runs Steps 1-4 automatically for one inbound message instead of
requiring each REST endpoint to be called by hand. Documents, payments, CRM, delivery/return and a
real persisted journey state machine (the Event/Workflow Engine) remain **not built** — see
`docs/PHASE-5-CHANNELS.md` for the full scope split.

```
Meta ── POST /webhooks/whatsapp (X-Hub-Signature-256) ──▶ Fastify API
                                                               │
                                          verifyMetaSignature() │ (raw body, constant-time compare;
                                          against WHATSAPP_APP_SECRET   401 on any mismatch, 501 if
                                                               │        the channel isn't configured)
                                                               ▼
                                          parseWhatsAppTextMessages()
                                          (tolerant Zod parse — ignores status callbacks and
                                           non-text message types, never throws on a strange shape)
                                                               │
                                                for each text message ▼
                                          claimIdempotencyKey("whatsapp:<meta message id>")
                                          (atomic create — a redelivery that arrives before the
                                           first attempt finishes sees `false` and stops here)
                                                               │
                                                               ▼
                                          runFullEnquiryPipeline()  — apps/api/services
                                                               │
                                    ┌──────────────┬───────────┼───────────┬──────────────┐
                                    ▼              ▼           ▼           ▼              │
                              submitEnquiry  extractDatesAndLocation  determineVehicle  checkMissingInfo
                              (Step 1)       (Step 2)                 (Step 3)          (Step 4)
                                    │              │           │           │              │
                                    └──────────────┴───────────┴───────────┴──────────────┘
                                          the exact same service each REST endpoint calls —
                                          nothing here re-implements Steps 1-4
                                                               │
                                                               ▼
                                          buildWhatsAppReplyText(missingInfo)
                                          (deterministic, template-based — same zero-hallucination
                                           discipline as clarificationPromptBuilder; never an LLM call)
                                                               │
                                                               ▼
                                          WhatsAppProvider.sendTextMessage(from, replyText)
                                          MetaWhatsAppProvider (real, via ssrfSafeFetch, host fixed
                                          to graph.facebook.com) or NotConfiguredWhatsAppProvider
                                          (result object, never throws — a failed/absent send must
                                           never fail the webhook ack Meta is waiting on)
                                                               │
                                                               ▼
                                          AuditEvent("whatsapp.reply_sent") +
                                          completeIdempotencyKey() — or, on any failure above,
                                          releaseIdempotencyKeyClaim() so a genuine retry isn't
                                          stuck behind a claim that will never complete
                                                               │
                                                               ▼
                                          200 { received: true }  (always fast, regardless of
                                          downstream outcome — a non-2xx makes Meta retry)
```

**Channel-agnostic pipeline, channel-specific adapter.** `runFullEnquiryPipeline`
(`apps/api/src/services/enquiryPipelineService.ts`) takes a `channel` + `customerRef` + `message`
and knows nothing about WhatsApp; the WhatsApp-specific pieces (signature verification, Meta's
webhook envelope shape, the Graph API send call) live entirely in `packages/channels`. A future Web
chat or Email adapter reuses the same pipeline function.

**Claim-before-work idempotency, not check-then-act.** Steps 1-4 plus an outbound HTTP call can
take seconds, and Meta redelivers a webhook that hasn't answered fast enough. A `find` followed by
a `save` at the end leaves a wide window for two concurrent deliveries to both run the pipeline and
both send a reply. `claimIdempotencyKey` (`packages/db`) makes the claim itself the concurrency
gate — a single unique-constraint insert two racing requests can't both win — proven with a
genuinely concurrent (`Promise.all`) redelivery test, not just a sequential one.

## Eligibility scope (journey Step 5 — `ELIGIBILITY_CHECK`)

`PHASE-CONTRACTS.json` id 11 — the journey-step-numbered continuation of Phases 1-4, not id 5's
"Channels, Documents, Payments, CRM & Fulfilment" scope (see `docs/PHASE-5-CHANNELS.md`). Unlike
every earlier step, there is **no AI proposal stage at all**: MASTER-PLAN.md marks this step's owner
"SYS", and CLAUDE.md is explicit that "AI may explain rules but MUST NOT decide policy
independently" / "Never allow AI to override policy" — so nothing in this step ever calls an
`AIProvider`.

```
POST /v1/enquiries/:conversationId/eligibility
{ customer: {...}, additionalDrivers: [...] }   (Zod .strict() body — new input this step
                │                                 introduces; Steps 1-4 never collect it)
                ▼
  findConversationById + findLatestMessageForConversation (tenant-scoped)
                │
                ▼
  fetch, in parallel: the message's latest DateLocationExtraction / VehicleDetermination,
  and the tenant's active EligibilityPolicy (no policy configured → 501 NOT_CONFIGURED,
  never a fake decision)
                │
                ▼
  findApplicableEligibilityExceptions(tenantId, { customerRef, nationality })
                │
                ▼
  EligibilityOrchestrator.evaluate(context, policy, exceptions)
                │
                ├─ validateEligibilityPolicy(policy.rules)
                │      (structural self-check — e.g. a nationality in both the blocked and
                │       allowed-only lists — fails safe to NEEDS_HUMAN_REVIEW instead of
                │       evaluating rules against a policy nobody can be sure is correct)
                │
                ├─ 7 EligibilityRule implementations, each pure/deterministic:
                │      AGE · LICENSE · PASSPORT · NATIONALITY · VEHICLE · LOCATION ·
                │      DRIVER_REQUIREMENT — every threshold/list they read comes from
                │      `policy.rules`, never hardcoded
                │
                ├─ resolveWithExceptions() per FAILed rule
                │      (a LOW-risk exception auto-waives it; a HIGH-risk one is recorded as
                │       matching but never auto-applied — "High-risk exceptions -> human")
                │
                └─ reasonBuilder.buildEligibilityReason()
                       (deterministic, template-based — never AI-generated free text)
                │
                ▼
  ELIGIBLE / INELIGIBLE / NEEDS_HUMAN_REVIEW
                │
                ▼
  one Prisma transaction: create EligibilityDecision + write AuditEvent
                │
                ▼
  201 { conversationId, messageId, decision }
```

**Policy and exceptions are data, not code.** `EligibilityPolicy` (versioned, append-only —
`createEligibilityPolicyVersion` inserts a new row and deactivates every previous one rather than
editing in place) and `EligibilityException` (VIP / nationality override / age override / manual
grant, each carrying its own `riskLevel`) are ordinary tenant-scoped DB rows, re-validated via Zod on
every read (`toDomainEligibilityPolicy`/`toDomainEligibilityException`) and validated before every
write (`eligibilityPolicyRulesSchema.parse`, `createEligibilityExceptionInputSchema.parse`) — the
same "never trust it just because it's our own DB" posture `toDomainVehicle` established. "Deterministic
and configurable" means every rule's _parameters_ live here; the rule _logic_ is fixed code in
`packages/ai/src/step5` that nothing (AI included) can override at decision time. No admin endpoint
manages these yet (Phase 7 Admin Dashboard scope) — today only `packages/db/src/seed.ts` and direct
repository calls create them, which is enough to prove the engine is genuinely policy-driven rather
than hardcoded.

**Every decision is auditable.** `EligibilityDecision` is an append-only row (the same convention as
`IntentRecord`/`DateLocationExtraction`/`VehicleDetermination`/`MissingInfoCheck`) carrying the exact
`policyId`/`policyVersion` evaluated, every rule's individual outcome, and which exceptions applied —
so a past decision can always be explained from its own stored row, never recomputed or guessed.

## Monorepo layout

```
apps/
  api/      Fastify + Zod + Prisma + BullMQ — the HTTP surface
  worker/   BullMQ Worker — post-enquiry background processing
  web/      Next.js (App Router) — enquiry form UI + a thin server-side proxy route
packages/
  domain/         pure business types & Zod schemas (Intent, Conversation, Temporal/Location, Vehicle, AppError, PII, audit, tenant)
  ai/             RuleBasedIntentEngine; Step 2: DateExtractionService, LocationExtractionService,
                  TemporalValidationService, DateLocationExtractionOrchestrator, Dubai/UAE gazetteer;
                  Step 3: VehicleIntentService, VehicleCatalogService, VehicleValidationService,
                  VehicleDeterminationOrchestrator; Step 4: RequiredFieldsEvaluator,
                  clarificationPromptBuilder, MissingInfoOrchestrator; Step 5: 7 EligibilityRule
                  implementations, policyValidator, exceptionResolver, reasonBuilder,
                  EligibilityOrchestrator — zero AI/LLM calls, deterministic only
  channels/       WhatsApp (Meta Cloud API) adapter: inbound payload parsing, signature
                  verification, WhatsAppProvider (Meta/NotConfigured), deterministic reply builder
  security/       secure headers, CORS allowlist, SSRF-safe fetch, webhook HMAC, CSRF primitive,
                  resilience primitives (timeout, circuit breaker, rate limiter)
  observability/  pino logger (with redaction), request correlation (AsyncLocalStorage), OTel bootstrap
  contracts/      HTTP request/response Zod schemas + BullMQ job schema shared by api/worker/web
  db/             Prisma schema, generated client, repositories (tenant-scoped), migrations
  config/         shared env schema + fail-fast loader
  testing/        shared test fixtures + real-Postgres/Redis test helpers (no mocks)
```

Every package that produces types other packages consume (`domain`, `config`, `security`,
`observability`, `ai`, `contracts`, `db`, `testing`) builds via plain `tsc` to `dist/`, resolved by
consumers through the normal `package.json` `main`/`types` fields — **not** TypeScript project
references. `pnpm -r` already runs scripts in dependency order, so a library's `typecheck` script
doubles as its `build` (both just run `tsc`); apps (`api`, `worker`, `web`), which nothing else
imports, use `tsc --noEmit` for typecheck since they don't need to emit for anyone.

## Data model

`Tenant`, `Conversation`, `Message`, `IntentRecord`, `AuditEvent`, `IdempotencyKey` (Phase 1),
`DateLocationExtraction` (Phase 2), `Vehicle` and `VehicleDetermination` (Phase 3),
`MissingInfoCheck` (Phase 4), `EligibilityPolicy`/`EligibilityException`/`EligibilityDecision`
(Step 5) — see `packages/db/prisma/schema.prisma`. Every business table carries
`tenantId`; every repository function takes `tenantId` explicitly and filters by it
(`findFirst`/`updateMany` with `tenantId` in the WHERE clause). This is the **application-level**
half of tenant isolation. Database-level Row Level Security is still not implemented — see Known
Limitations in `docs/phases/PHASE-01.md`, `docs/PHASE-2.md`, `docs/PHASE-3.md`,
`docs/PHASE-4.md` and `docs/PHASE-5.md`. `Vehicle` additionally supports soft deletion (`deletedAt`)
— every repository query excludes soft-deleted rows, and nothing in the codebase issues a hard
`DELETE` on that table. `EligibilityPolicy` is similarly append-only-by-convention: a new version is
inserted and every previous one deactivated, never an in-place update.

## Security posture (Phase 1)

| Control                                                | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input validation                                       | Zod at the HTTP boundary (`@fastify/type-provider-zod`) and again at the Next.js route handler                                                                                                                                                                                                                                                                                                                                        |
| Request size limits                                    | Fastify `bodyLimit` (`API_BODY_LIMIT_BYTES`, default 100 KB)                                                                                                                                                                                                                                                                                                                                                                          |
| Rate limiting                                          | `@fastify/rate-limit`, per-IP, configurable window/max                                                                                                                                                                                                                                                                                                                                                                                |
| CORS                                                   | explicit allowlist (`CORS_ALLOWED_ORIGINS`), no wildcard                                                                                                                                                                                                                                                                                                                                                                              |
| Secure headers / CSP                                   | `@fastify/helmet`, deny-by-default CSP (`packages/security/headers.ts`)                                                                                                                                                                                                                                                                                                                                                               |
| SSRF protection                                        | `ssrfSafeFetch`: allowlist + DNS-rebinding check + no auto-redirects; used by the Next.js route handler calling the API                                                                                                                                                                                                                                                                                                               |
| SQL injection                                          | Prisma parameterized queries only; no raw SQL with interpolated input                                                                                                                                                                                                                                                                                                                                                                 |
| XSS                                                    | React auto-escaping; no `dangerouslySetInnerHTML`; JSON API responses                                                                                                                                                                                                                                                                                                                                                                 |
| Webhook signatures                                     | HMAC-SHA256 sign/verify primitive (`packages/security/webhookSignature.ts`); wired to a real channel as of Phase 5 (WhatsApp — see below)                                                                                                                                                                                                                                                                                             |
| CSRF                                                   | double-submit primitive shipped, not mounted (API is stateless/token-based; no cookie session exists yet — see Known Limitations)                                                                                                                                                                                                                                                                                                     |
| Secrets                                                | `.env` only, never committed; pino redaction paths strip secrets/PII from logs                                                                                                                                                                                                                                                                                                                                                        |
| PII                                                    | `classifyPII`/`redactPII` in `packages/domain`; log redaction also strips raw message content                                                                                                                                                                                                                                                                                                                                         |
| Audit                                                  | every mutation (`enquiry.received`, `conversation.processed`) writes an `AuditEvent` in the same transaction                                                                                                                                                                                                                                                                                                                          |
| Tenant isolation                                       | application-level (see Data model); DB-level RLS is Phase 2/6                                                                                                                                                                                                                                                                                                                                                                         |
| Prompt-injection defense                               | `sanitizeForProcessing` flags known injection patterns; Phase 1's engine is deterministic so nothing can actually be hijacked, but the signal is captured now for Phase 4                                                                                                                                                                                                                                                             |
| Outbound allowlist                                     | `OUTBOUND_ALLOWED_HOSTS` enforced by `ssrfSafeFetch`                                                                                                                                                                                                                                                                                                                                                                                  |
| Geocoding provider abstraction                         | `LocationProvider` interface (`packages/ai/step2`) — Phase 2's `GazetteerLocationProvider` makes zero network calls; any future network-based provider must go through `ssrfSafeFetch`, never a raw `fetch` on caller-influenced input                                                                                                                                                                                                |
| Timeouts / circuit breaker / rate limit                | `packages/security/resilience.ts` — generic primitives, applied to the location provider seam (`ResilientLocationProvider`) even though the current provider doesn't need them, so the safety net is exercised now                                                                                                                                                                                                                    |
| Never invent inventory                                 | `VehicleCatalogProvider` interface (`packages/ai/step3`) — the matching lexicon and every resolved/alternative vehicle always come from the tenant's real `Vehicle` rows; proven with a prompt-injection payload asking for a vehicle that doesn't exist                                                                                                                                                                              |
| Vehicle catalog constraints                            | `@@unique([tenantId, make, model])`, soft delete (`deletedAt`, never a hard `DELETE`), tenant-scoped repository functions, `AppError('CONFLICT', ...)` on a duplicate identity instead of a raw driver error                                                                                                                                                                                                                          |
| Never re-derives from raw text                         | `RequiredFieldsEvaluator` (`packages/ai/step4`) only ever reads Steps 1-3's already-verified output; it has no code path that could itself hallucinate a date, location, or vehicle                                                                                                                                                                                                                                                   |
| Injection visibility carried forward                   | Step 4 aggregates each earlier step's own `promptInjectionDetected` flag into one `flags.promptInjectionDetectedAnywhere` rather than re-sanitizing (there is no new raw text to sanitize)                                                                                                                                                                                                                                            |
| WhatsApp webhook authenticity                          | `verifyMetaSignature` (`packages/channels`) — HMAC-SHA256 over the _raw_ request body (a dedicated Fastify content-type parser captures it before JSON parsing), constant-time compare, exact-64-hex-char check (rejects a valid signature with trailing bytes appended, which Node's lenient hex decoder would otherwise silently truncate and still match); missing/wrong secret is `NOT_CONFIGURED`/`UNAUTHORIZED`, never a bypass |
| WhatsApp outbound egress                               | `MetaWhatsAppProvider` calls only `graph.facebook.com`, hardcoded independent of `OUTBOUND_ALLOWED_HOSTS`, via `ssrfSafeFetch`; never throws — returns a `SENT`/`FAILED`/`NOT_CONFIGURED` result so a downstream send problem can never fail the inbound webhook ack                                                                                                                                                                  |
| WhatsApp webhook idempotency                           | `claimIdempotencyKey` (atomic insert, not read-then-write) keyed on Meta's own message id, released on failure (`releaseIdempotencyKeyClaim`) so a genuine retry isn't stuck; proven with a concurrent (`Promise.all`) redelivery test                                                                                                                                                                                                |
| Eligibility never lets AI decide                       | `EligibilityOrchestrator` (`packages/ai/src/step5`) makes zero `AIProvider` calls; every rule reads only `policy.rules` and the request's own validated input — matches CLAUDE.md's "AI may explain rules but MUST NOT decide policy independently"                                                                                                                                                                                   |
| Eligibility request body can't dictate its own outcome | `checkEligibilityBodySchema` is `.strict()` — an unrecognized field (`status`, `policyId`, `decision`, `__proto__`, ...) is rejected with 400 before the service layer ever runs; the decision is always server-computed from the tenant's own active policy                                                                                                                                                                          |
| Eligibility policy conflicts fail safe                 | `validateEligibilityPolicy` checks the tenant's own policy for internal contradictions (e.g. a nationality in both the blocked and allowed-only lists) before any rule runs; a conflict short-circuits straight to `NEEDS_HUMAN_REVIEW`, never a guessed resolution                                                                                                                                                                   |
| Eligibility exceptions validated before write          | `createEligibilityException` parses `waivedCategories`/`scopeNationality`/etc. against `createEligibilityExceptionInputSchema` before persisting, so a malformed row can never later break every read for that tenant (`toDomainEligibilityException` re-validates on every read too)                                                                                                                                                 |

## AI Intent Engine

`RuleBasedIntentEngine` (`packages/ai`) is **deterministic** — regex/keyword based, zero network
calls, zero hallucination risk. It classifies one of the 10 `IntentType` values, extracts entities
(vehicle, dates, location, passenger count, driver requirement, language, urgency) only when real
evidence is present in the message, and returns `NEEDS_CLARIFICATION` whenever confidence is below
threshold or a `BOOKING_REQUEST` is missing a required field. Output is always validated against
`intentResultSchema` (Zod) before it leaves the engine. A real LLM provider is Phase 4 scope; the
`AIProvider`/`NotConfiguredProvider` seam already exists in `packages/ai/provider.ts` so that phase
implements an adapter rather than inventing the boundary under deadline pressure.

## Step 2 — Date & Location Extraction

- **`DateExtractionService`** — deterministic regex-based date proposal. Named-month dates, day
  ranges, ISO dates, numeric dates, `tomorrow`/`today`, `next <weekday>`. A numeric date whose
  day/month could be read either way (e.g. `10/11/26`) is reported as an `AMBIGUOUS_NUMERIC_DATE`
  ambiguity, never guessed; an impossible calendar date (`31 February`, `32/13/2026`) is verified
  via round-tripping through `Date.UTC` (`packages/ai/step2/calendar.ts`) and reported, never
  silently rounded. All resolved dates go through `zonedTimeToUtc` (`packages/ai/step2/timezone.ts`)
  — a DST-aware local-time→UTC conversion built on `Intl.DateTimeFormat`, no extra dependency.
- **`LocationExtractionService`** — resolves pickup/dropoff against an injected `LocationProvider`
  (`GazetteerLocationProvider` for Phase 2: a static Dubai/UAE gazetteer, zero network calls). Two
  distinct "couldn't resolve" signals: `UNRECOGNIZED_LOCATION_TEXT` (doesn't look like a known
  place) vs. `UNSUPPORTED_LOCATION` (a real, known city — e.g. London — just outside the current
  service area), the latter forward-compatible with "future cities/countries" once the gazetteer or
  a real geocoding provider grows.
- **`TemporalValidationService`** — the deterministic verifier. Checks: `PAST_DATE`,
  `RETURN_BEFORE_OR_EQUAL_PICKUP`, `IMPOSSIBLE_DATE`, `UNSUPPORTED_LOCATION`, `TIMEZONE_MISMATCH`
  (an explicit timezone mention in the message — e.g. "3pm EST" — conflicting with the resolved
  location's actual UTC offset at that instant). Computes a 0–1 confidence score and is the only
  place a `DateLocationExtractionResult` is constructed and Zod-validated.
- **`DateLocationExtractionOrchestrator`** — wires the three together: sanitize → locate → date →
  validate, defaulting to `Asia/Dubai` when no location resolved (Phase 2's single-market default,
  see `docs/phases/PHASE-2.md`).

## Step 3 — Determine Vehicle

- **`VehicleIntentService`** — pure, zero-I/O proposal step. Tiered, mutually-exclusive matching
  against a DB-sourced lexicon: exact model → brand only (unambiguous if the brand has one model) →
  category only (unambiguous if the category has one model) → typo-tolerant fuzzy match (a small,
  self-written Levenshtein implementation, `packages/ai/step3/levenshtein.ts`, no new dependency).
  Never proposes an id absent from the lexicon it was given; when nothing matches, reports either a
  vehicle-shaped phrase it couldn't resolve (for `UNKNOWN_VEHICLE`) or nothing at all (for
  `NO_VEHICLE_MENTIONED`) — a lone capitalized sentence-initial word ("What", "I") is deliberately
  never mistaken for either.
- **`VehicleCatalogService`** — the only class that talks to the real fleet, via an injected
  `VehicleCatalogProvider` (`PrismaVehicleCatalogProvider` in `apps/api`, tenant-scoped on every
  call — unlike Step 2's tenant-agnostic static gazetteer). Supplies the lexicon, the full records
  for whatever `VehicleIntentService` proposed, and a small set of genuinely bookable alternatives —
  widening from a category-scoped search to the general active fleet if the narrower one comes up
  empty, so a customer is never left with nothing to choose from.
- **`VehicleValidationService`** — the deterministic verifier. Decides `RESOLVED` (single, active,
  `AVAILABLE` match) vs. `NEEDS_CLARIFICATION` (multiple candidates, or nothing mentioned) vs.
  `UNSUPPORTED` (`UNKNOWN_VEHICLE`, `VEHICLE_INACTIVE`, or `VEHICLE_UNAVAILABLE`). Computes a 0–1
  confidence score and is the only place a `VehicleDeterminationResult` is constructed and
  Zod-validated.
- **`VehicleDeterminationOrchestrator`** — wires the three together: sanitize → lexicon → propose →
  resolve → validate. Requires a real `VehicleCatalogProvider` (no zero-config default exists, unlike
  Step 2's Dubai/UAE gazetteer, since there's no sensible generic fleet to fall back to).
- **Three distinct "not available" states**, deliberately kept separate: `deletedAt` (soft-deleted —
  behaves as if the vehicle never existed), `active` (a real entry, disabled by the business —
  `VEHICLE_INACTIVE`), `availabilityStatus` (a real, active entry temporarily down —
  `VEHICLE_UNAVAILABLE`, a catalog-level flag only, not a date-range booking calendar; that's journey
  Step 6, a distinct later phase).

## Step 4 — Ask Missing Information

- **`RequiredFieldsEvaluator`** — pure, zero-I/O. Checks four required fields (`PICKUP_DATE`,
  `RETURN_DATE`, `PICKUP_LOCATION`, `VEHICLE` — matching Phase 1's own `BOOKING_REQUIRED_FIELDS`,
  now backed by Steps 2-3's real verified values instead of Phase 1's keyword-evidence check)
  against narrow `IntentSnapshot`/`DateLocationSnapshot`/`VehicleSnapshot` inputs. A missing field
  carries one of three reasons: `NOT_PROVIDED` (the step never ran, or found nothing),
  `AMBIGUOUS` (the step flagged an ambiguity), `INVALID` (the step rejected a resolved value, e.g.
  `PAST_DATE` or `VEHICLE_INACTIVE`). A non-`BOOKING_REQUEST` intent short-circuits to
  `NOT_APPLICABLE`; an incomplete conversation past the 24h window is `EXPIRED` instead of
  `NEEDS_INFO`. `dropoffLocation` is read into `collected` for transparency but is never required.
- **`buildClarificationPrompt`** — deterministic, template-based (no LLM call): one combined,
  Oxford-comma-joined question covering every current gap, so a single customer reply can address
  all of them rather than being asked one question at a time.
- **`MissingInfoOrchestrator`** — wires the two together; fully synchronous (no I/O of its own — the
  three snapshots are fetched by the API service layer and handed in already resolved), computes
  `expiresAt` (`conversationCreatedAt` + `MISSING_INFO_TIMEOUT_HOURS`), and is the only place a
  `MissingInfoResult` is constructed and Zod-validated.

## Observability

Structured JSON logs (pino) with request correlation via `AsyncLocalStorage`, `x-request-id`
propagated on every response. OpenTelemetry tracing bootstraps only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set — otherwise `bootstrapObservability` returns
`NOT_CONFIGURED` and no exporter runs (see Health API below).

## Health / readiness

- `GET /health` — process identity + `observability` status (`CONFIGURED`/`NOT_CONFIGURED`)
- `GET /live` — liveness + uptime
- `GET /ready` — checks Postgres (`SELECT 1`) and Redis (`PING`); 503 if either is down
