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

## Monorepo layout

```
apps/
  api/      Fastify + Zod + Prisma + BullMQ — the HTTP surface
  worker/   BullMQ Worker — post-enquiry background processing
  web/      Next.js (App Router) — enquiry form UI + a thin server-side proxy route
packages/
  domain/         pure business types & Zod schemas (Intent, Conversation, AppError, PII, audit, tenant)
  ai/             RuleBasedIntentEngine, prompt-injection sanitizer, date/lexicon extraction
  security/       secure headers, CORS allowlist, SSRF-safe fetch, webhook HMAC, CSRF primitive
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

## Data model (Phase 1)

`Tenant`, `Conversation`, `Message`, `IntentRecord`, `AuditEvent`, `IdempotencyKey` — see
`packages/db/prisma/schema.prisma`. Every business table carries `tenantId`; every repository
function takes `tenantId` explicitly and filters by it (`findFirst`/`updateMany` with `tenantId` in
the WHERE clause). This is the **application-level** half of tenant isolation. Database-level Row
Level Security is a Phase 2/6 addition, not yet implemented — see Known Limitations in
`docs/phases/PHASE-01.md`.

## Security posture (Phase 1)

| Control                  | Implementation                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input validation         | Zod at the HTTP boundary (`@fastify/type-provider-zod`) and again at the Next.js route handler                                                                            |
| Request size limits      | Fastify `bodyLimit` (`API_BODY_LIMIT_BYTES`, default 100 KB)                                                                                                              |
| Rate limiting            | `@fastify/rate-limit`, per-IP, configurable window/max                                                                                                                    |
| CORS                     | explicit allowlist (`CORS_ALLOWED_ORIGINS`), no wildcard                                                                                                                  |
| Secure headers / CSP     | `@fastify/helmet`, deny-by-default CSP (`packages/security/headers.ts`)                                                                                                   |
| SSRF protection          | `ssrfSafeFetch`: allowlist + DNS-rebinding check + no auto-redirects; used by the Next.js route handler calling the API                                                   |
| SQL injection            | Prisma parameterized queries only; no raw SQL with interpolated input                                                                                                     |
| XSS                      | React auto-escaping; no `dangerouslySetInnerHTML`; JSON API responses                                                                                                     |
| Webhook signatures       | HMAC-SHA256 sign/verify primitive (`packages/security/webhookSignature.ts`) — not yet wired to a real channel (Phase 5)                                                   |
| CSRF                     | double-submit primitive shipped, not mounted (API is stateless/token-based; no cookie session exists yet — see Known Limitations)                                         |
| Secrets                  | `.env` only, never committed; pino redaction paths strip secrets/PII from logs                                                                                            |
| PII                      | `classifyPII`/`redactPII` in `packages/domain`; log redaction also strips raw message content                                                                             |
| Audit                    | every mutation (`enquiry.received`, `conversation.processed`) writes an `AuditEvent` in the same transaction                                                              |
| Tenant isolation         | application-level (see Data model); DB-level RLS is Phase 2/6                                                                                                             |
| Prompt-injection defense | `sanitizeForProcessing` flags known injection patterns; Phase 1's engine is deterministic so nothing can actually be hijacked, but the signal is captured now for Phase 4 |
| Outbound allowlist       | `OUTBOUND_ALLOWED_HOSTS` enforced by `ssrfSafeFetch`                                                                                                                      |

## AI Intent Engine

`RuleBasedIntentEngine` (`packages/ai`) is **deterministic** — regex/keyword based, zero network
calls, zero hallucination risk. It classifies one of the 10 `IntentType` values, extracts entities
(vehicle, dates, location, passenger count, driver requirement, language, urgency) only when real
evidence is present in the message, and returns `NEEDS_CLARIFICATION` whenever confidence is below
threshold or a `BOOKING_REQUEST` is missing a required field. Output is always validated against
`intentResultSchema` (Zod) before it leaves the engine. A real LLM provider is Phase 4 scope; the
`AIProvider`/`NotConfiguredProvider` seam already exists in `packages/ai/provider.ts` so that phase
implements an adapter rather than inventing the boundary under deadline pressure.

## Observability

Structured JSON logs (pino) with request correlation via `AsyncLocalStorage`, `x-request-id`
propagated on every response. OpenTelemetry tracing bootstraps only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set — otherwise `bootstrapObservability` returns
`NOT_CONFIGURED` and no exporter runs (see Health API below).

## Health / readiness

- `GET /health` — process identity + `observability` status (`CONFIGURED`/`NOT_CONFIGURED`)
- `GET /live` — liveness + uptime
- `GET /ready` — checks Postgres (`SELECT 1`) and Redis (`PING`); 503 if either is down
