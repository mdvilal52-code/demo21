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

The first genuinely stateful, multi-turn journey step — Steps 1-3 were each single-pass. Input is
the conversation's latest message (via a new, dedicated reply endpoint), plus Steps 1-3's
already-persisted results read fresh on every call, plus this conversation's own prior Step 4 state.

```
POST /v1/enquiries/:conversationId/messages          (append a customer reply; idempotent)
POST /v1/enquiries/:conversationId/missing-information (process the latest reply; no request body)
                │
                ▼
  five tenant-scoped reads in parallel: latest message, Step 1 intent, Step 2 dates/location,
  Step 3 vehicle-determined?, prior MissingInformationState (null on turn 1)
                │
                ├─ replay? (same messageId as last processed call)
                │      buildResultFromState() — reconstructs the current view from persisted
                │      state alone, no extraction — never reprocesses the same message twice
                │
                └─ genuine new turn ──▶ MissingInformationEngine.processTurn()
                       │
                       ├─ sanitizeForProcessing()        — prompt-injection screen (reused from Phase 1)
                       │
                       ├─ AnswerExtractionService.extract*()
                       │      (AI proposes: flight number / pickup time / driver requirement /
                       │       contact details by pattern; dropoff address / special requests only
                       │       as a reply to a field this conversation itself asked about earlier)
                       │
                       ├─ ConversationState.applyCandidates()
                       │      (deterministic merge: new answer / correction / contradiction —
                       │       repeated answers are a no-op, idempotent by construction)
                       │
                       ├─ MissingFieldDetector.detect()
                       │      (deterministic verifier: which required fields are still genuinely
                       │       missing, given real Step 1-3 data — e.g. no flight number question
                       │       unless Step 2 actually resolved an AIRPORT pickup)
                       │
                       └─ QuestionPolicy.selectNewQuestions()
                              (typed templates only, en/ar; never re-asks a field once asked;
                               at most one free-text question pending at a time, required
                               fields bump an optional one out of that slot rather than being
                               blocked by it)
                │
                ▼
  one Prisma transaction: save MissingInformationState (version-checked) + write AuditEvent
                │
                ▼
  201 { conversationId, messageId, result: { status, missingFields, pendingQuestions, answers,
        corrections, contradictions, flags, modelMetadata } }
```

**AI proposes, deterministic domain logic verifies** — the same split as Steps 1-3, a fourth time,
plus the piece those steps never needed: `ConversationState` (functional-core, immutable — every
method returns a new instance) is the only place multi-turn state is merged, and the only place an
answer, correction or contradiction record is constructed (always through its Zod schema). An
abuse-protection turn cap (`MAX_MISSING_INFO_TURNS`) is enforced by the caller (`missingInformationService`)
before the engine ever runs, and never counts a replay against it.

**Never a fake conversation** — the endpoint takes no body; the message it processes is always one
already durably stored via `POST .../messages`, the same "read the stored message, never re-parse
request-body text" convention Steps 2-3 established.

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
                  VehicleDeterminationOrchestrator; Step 4: AnswerExtractionService,
                  MissingFieldDetector, QuestionPolicy, ConversationState, MissingInformationEngine
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
`MissingInformationState` (Phase 4) — see `packages/db/prisma/schema.prisma`. Every business table
carries `tenantId`; every repository function takes `tenantId` explicitly and filters by it
(`findFirst`/`updateMany` with `tenantId` in the WHERE clause). This is the **application-level**
half of tenant isolation. Database-level Row Level Security is still not implemented — see Known
Limitations in `docs/phases/PHASE-01.md`, `docs/PHASE-2.md`, `docs/PHASE-3.md` and `docs/PHASE-4.md`.
`Vehicle` additionally supports soft deletion (`deletedAt`) — every repository query excludes
soft-deleted rows, and nothing in the codebase issues a hard `DELETE` on that table.
`MissingInformationState` is one row per conversation (`conversationId` unique), updated in place
turn by turn under an optimistic `version` check — the one table in the schema that is mutated
rather than appended-to, since it is genuinely the current state of an in-progress conversation, not
a history of individual runs like `IntentRecord`/`DateLocationExtraction`/`VehicleDetermination`.

## Security posture (Phase 1)

| Control                                    | Implementation                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input validation                           | Zod at the HTTP boundary (`@fastify/type-provider-zod`) and again at the Next.js route handler                                                                                                                                                                                                                                                                            |
| Request size limits                        | Fastify `bodyLimit` (`API_BODY_LIMIT_BYTES`, default 100 KB)                                                                                                                                                                                                                                                                                                              |
| Rate limiting                              | `@fastify/rate-limit`, per-IP, configurable window/max                                                                                                                                                                                                                                                                                                                    |
| CORS                                       | explicit allowlist (`CORS_ALLOWED_ORIGINS`), no wildcard                                                                                                                                                                                                                                                                                                                  |
| Secure headers / CSP                       | `@fastify/helmet`, deny-by-default CSP (`packages/security/headers.ts`)                                                                                                                                                                                                                                                                                                   |
| SSRF protection                            | `ssrfSafeFetch`: allowlist + DNS-rebinding check + no auto-redirects; used by the Next.js route handler calling the API                                                                                                                                                                                                                                                   |
| SQL injection                              | Prisma parameterized queries only; no raw SQL with interpolated input                                                                                                                                                                                                                                                                                                     |
| XSS                                        | React auto-escaping; no `dangerouslySetInnerHTML`; JSON API responses                                                                                                                                                                                                                                                                                                     |
| Webhook signatures                         | HMAC-SHA256 sign/verify primitive (`packages/security/webhookSignature.ts`) — not yet wired to a real channel (Phase 5)                                                                                                                                                                                                                                                   |
| CSRF                                       | double-submit primitive shipped, not mounted (API is stateless/token-based; no cookie session exists yet — see Known Limitations)                                                                                                                                                                                                                                         |
| Secrets                                    | `.env` only, never committed; pino redaction paths strip secrets/PII from logs                                                                                                                                                                                                                                                                                            |
| PII                                        | `classifyPII`/`redactPII` in `packages/domain`; log redaction also strips raw message content                                                                                                                                                                                                                                                                             |
| Audit                                      | every mutation (`enquiry.received`, `conversation.processed`) writes an `AuditEvent` in the same transaction                                                                                                                                                                                                                                                              |
| Tenant isolation                           | application-level (see Data model); DB-level RLS is Phase 2/6                                                                                                                                                                                                                                                                                                             |
| Prompt-injection defense                   | `sanitizeForProcessing` flags known injection patterns; every phase's engine so far (1-4) is deterministic so nothing can actually be hijacked, but the signal is captured and surfaced (Step 4 returns it as `flags.promptInjectionDetected`) for whichever future phase puts a real LLM behind one of these seams                                                       |
| Outbound allowlist                         | `OUTBOUND_ALLOWED_HOSTS` enforced by `ssrfSafeFetch`                                                                                                                                                                                                                                                                                                                      |
| Geocoding provider abstraction             | `LocationProvider` interface (`packages/ai/step2`) — Phase 2's `GazetteerLocationProvider` makes zero network calls; any future network-based provider must go through `ssrfSafeFetch`, never a raw `fetch` on caller-influenced input                                                                                                                                    |
| Timeouts / circuit breaker / rate limit    | `packages/security/resilience.ts` — generic primitives, applied to the location provider seam (`ResilientLocationProvider`) even though the current provider doesn't need them, so the safety net is exercised now                                                                                                                                                        |
| Never invent inventory                     | `VehicleCatalogProvider` interface (`packages/ai/step3`) — the matching lexicon and every resolved/alternative vehicle always come from the tenant's real `Vehicle` rows; proven with a prompt-injection payload asking for a vehicle that doesn't exist                                                                                                                  |
| Vehicle catalog constraints                | `@@unique([tenantId, make, model])`, soft delete (`deletedAt`, never a hard `DELETE`), tenant-scoped repository functions, `AppError('CONFLICT', ...)` on a duplicate identity instead of a raw driver error                                                                                                                                                              |
| Never expose internal prompts/instructions | `QuestionPolicy` only ever renders one of a fixed, versioned set of typed templates (`fieldTemplates.ts`) — no template is ever generated from customer text or a system prompt, so there is nothing that could leak through a rendered question                                                                                                                          |
| PII minimization                           | `classifyPII` flags PII in the raw message (`flags.piiDetected`); free-text answers (address/special requests) are only ever captured as the reply to a field the conversation itself asked about — an unrelated PII-bearing sentence (e.g. a passport number) is never opportunistically stored; audit events record field/answer _counts_ only, never raw answer values |
| Abuse protection / rate limiting           | `MAX_MISSING_INFO_TURNS` turn cap enforced by `missingInformationService` before the engine runs (not by the engine itself, which never throws); a replayed/idempotent retry of the same message is reconstructed from persisted state and never counts against the cap                                                                                                   |

## AI Intent Engine

`RuleBasedIntentEngine` (`packages/ai`) is **deterministic** — regex/keyword based, zero network
calls, zero hallucination risk. It classifies one of the 10 `IntentType` values, extracts entities
(vehicle, dates, location, passenger count, driver requirement, language, urgency) only when real
evidence is present in the message, and returns `NEEDS_CLARIFICATION` whenever confidence is below
threshold or a `BOOKING_REQUEST` is missing a required field. Output is always validated against
`intentResultSchema` (Zod) before it leaves the engine. A real LLM provider remains a distinct,
not-yet-numbered future phase — Phases 2-4 turned out deterministic/rule-based too, same as Phase 1;
the `AIProvider`/`NotConfiguredProvider` seam already exists in `packages/ai/provider.ts` so that
future phase implements an adapter rather than inventing the boundary under deadline pressure.

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

- **`AnswerExtractionService`** — pure, zero-I/O proposal step. Structured fields (flight number,
  pickup time, driver requirement, contact details) are pattern-matched unconditionally, each with
  real textual evidence (e.g. a flight number regex, an explicit am/pm or `HH:MM` time, a negation-
  aware driver-requirement keyword check so "I don't need a driver" is never misread as the opposite
  of what the customer said). Free text (dropoff address, special requests) is never scanned
  opportunistically — it is only ever captured as the answer to a field this same conversation asked
  about in an earlier turn, with an anchor-phrase regex ("drop off at …") tried first so a reply that
  mixes an address in with other information captures just the address.
- **`ConversationState`** — functional-core, immutable (every method returns a new instance). The
  only place a customer's candidate answers are merged into the conversation's running answer set:
  a single new value is a new answer, a differing value for an already-answered field is a
  _correction_ (newest statement wins), two different values in the same message are a
  _contradiction_ (both discarded, neither trusted), and a repeated value is a no-op — idempotent by
  construction. Also owns the single-slot free-text question rule: a required field can _withdraw_ an
  optional field's pending question to take the slot, but never the reverse.
- **`MissingFieldDetector`** — the deterministic verifier, mirroring
  `TemporalValidationService`/`VehicleValidationService`'s role in Steps 2-3. The sole authority on
  "genuinely missing": a field's _requiredness_ is computed from real Step 1-3 data only (e.g. a
  flight number is only required when Step 2 actually resolved an `AIRPORT` pickup location), and a
  field already present in the answer set — from Step 1, a prior turn, or this turn — is never
  reported as missing, however it got there.
- **`QuestionPolicy`** — typed question templates only (English + Arabic), nothing generated from
  customer text, so there is no internal prompt or instruction that could ever leak through a
  rendered question. Never re-asks a field once its `askedFieldKeys` entry exists; optional fields
  (special requests) are offered at most once, after every required field.
- **`MissingInformationEngine`** — wires all four together: sanitize → extract → merge → detect →
  select questions → persist-shape. The first step to carry state across HTTP calls
  (`MissingInformationState`, one row per conversation) rather than being single-pass like Steps 1-3;
  `buildResultFromState` reconstructs a replayed call's result from persisted state alone (never
  re-running extraction) so a retried request can never misread its own original message as a reply
  to a question that same message just caused to be asked.

## Observability

Structured JSON logs (pino) with request correlation via `AsyncLocalStorage`, `x-request-id`
propagated on every response. OpenTelemetry tracing bootstraps only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set — otherwise `bootstrapObservability` returns
`NOT_CONFIGURED` and no exporter runs (see Health API below).

## Health / readiness

- `GET /health` — process identity + `observability` status (`CONFIGURED`/`NOT_CONFIGURED`)
- `GET /live` — liveness + uptime
- `GET /ready` — checks Postgres (`SELECT 1`) and Redis (`PING`); 503 if either is down
