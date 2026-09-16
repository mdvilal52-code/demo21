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

## Monorepo layout

```
apps/
  api/      Fastify + Zod + Prisma + BullMQ — the HTTP surface
  worker/   BullMQ Worker — post-enquiry background processing
  web/      Next.js (App Router) — enquiry form UI + a thin server-side proxy route
packages/
  domain/         pure business types & Zod schemas (Intent, Conversation, Temporal/Location, AppError, PII, audit, tenant)
  ai/             RuleBasedIntentEngine; Step 2: DateExtractionService, LocationExtractionService,
                  TemporalValidationService, DateLocationExtractionOrchestrator, Dubai/UAE gazetteer
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

`Tenant`, `Conversation`, `Message`, `IntentRecord`, `AuditEvent`, `IdempotencyKey` (Phase 1) plus
`DateLocationExtraction` (Phase 2) — see `packages/db/prisma/schema.prisma`. Every business table
carries `tenantId`; every repository function takes `tenantId` explicitly and filters by it
(`findFirst`/`updateMany` with `tenantId` in the WHERE clause). This is the **application-level**
half of tenant isolation. Database-level Row Level Security is still not implemented — see Known
Limitations in `docs/phases/PHASE-01.md` and `docs/phases/PHASE-2.md`.

## Security posture (Phase 1)

| Control                                 | Implementation                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input validation                        | Zod at the HTTP boundary (`@fastify/type-provider-zod`) and again at the Next.js route handler                                                                                                                                         |
| Request size limits                     | Fastify `bodyLimit` (`API_BODY_LIMIT_BYTES`, default 100 KB)                                                                                                                                                                           |
| Rate limiting                           | `@fastify/rate-limit`, per-IP, configurable window/max                                                                                                                                                                                 |
| CORS                                    | explicit allowlist (`CORS_ALLOWED_ORIGINS`), no wildcard                                                                                                                                                                               |
| Secure headers / CSP                    | `@fastify/helmet`, deny-by-default CSP (`packages/security/headers.ts`)                                                                                                                                                                |
| SSRF protection                         | `ssrfSafeFetch`: allowlist + DNS-rebinding check + no auto-redirects; used by the Next.js route handler calling the API                                                                                                                |
| SQL injection                           | Prisma parameterized queries only; no raw SQL with interpolated input                                                                                                                                                                  |
| XSS                                     | React auto-escaping; no `dangerouslySetInnerHTML`; JSON API responses                                                                                                                                                                  |
| Webhook signatures                      | HMAC-SHA256 sign/verify primitive (`packages/security/webhookSignature.ts`) — not yet wired to a real channel (Phase 5)                                                                                                                |
| CSRF                                    | double-submit primitive shipped, not mounted (API is stateless/token-based; no cookie session exists yet — see Known Limitations)                                                                                                      |
| Secrets                                 | `.env` only, never committed; pino redaction paths strip secrets/PII from logs                                                                                                                                                         |
| PII                                     | `classifyPII`/`redactPII` in `packages/domain`; log redaction also strips raw message content                                                                                                                                          |
| Audit                                   | every mutation (`enquiry.received`, `conversation.processed`) writes an `AuditEvent` in the same transaction                                                                                                                           |
| Tenant isolation                        | application-level (see Data model); DB-level RLS is Phase 2/6                                                                                                                                                                          |
| Prompt-injection defense                | `sanitizeForProcessing` flags known injection patterns; Phase 1's engine is deterministic so nothing can actually be hijacked, but the signal is captured now for Phase 4                                                              |
| Outbound allowlist                      | `OUTBOUND_ALLOWED_HOSTS` enforced by `ssrfSafeFetch`                                                                                                                                                                                   |
| Geocoding provider abstraction          | `LocationProvider` interface (`packages/ai/step2`) — Phase 2's `GazetteerLocationProvider` makes zero network calls; any future network-based provider must go through `ssrfSafeFetch`, never a raw `fetch` on caller-influenced input |
| Timeouts / circuit breaker / rate limit | `packages/security/resilience.ts` — generic primitives, applied to the location provider seam (`ResilientLocationProvider`) even though the current provider doesn't need them, so the safety net is exercised now                     |

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

## Observability

Structured JSON logs (pino) with request correlation via `AsyncLocalStorage`, `x-request-id`
propagated on every response. OpenTelemetry tracing bootstraps only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set — otherwise `bootstrapObservability` returns
`NOT_CONFIGURED` and no exporter runs (see Health API below).

## Health / readiness

- `GET /health` — process identity + `observability` status (`CONFIGURED`/`NOT_CONFIGURED`)
- `GET /live` — liveness + uptime
- `GET /ready` — checks Postgres (`SELECT 1`) and Redis (`PING`); 503 if either is down
