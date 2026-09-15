# Phase 1 — Foundation & Platform Skeleton + Enquiry / Intent Recognition

Status: **FROZEN**

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`, `docs/MASTER-PLAN.md`.
- No previous phase existed (this is the first). Repository contained only planning docs.
- Local Postgres 16 and Redis 7 servers were used for real integration testing (no Docker daemon
  available in this sandbox; `docker-compose.yml` is provided for normal local/CI use).

## 2. Scope

Goal: production-grade monorepo foundation (api/worker/web, db, cache, observability, security,
design tokens) **and** the first business step — Enquiry / Intent Recognition — end to end:
customer message → deterministic AI intent engine → persisted conversation/message/intent/audit →
queued background processing → recognized intent returned to the customer.

Out of scope (explicitly deferred, see §7): later business phases (booking, payment, documents,
real LLM provider, RLS, admin dashboard).

## 3. Design decisions

- **No TS project references.** Library packages build with plain `tsc` to `dist/`; apps resolve
  them via normal `package.json` `main`/`types` fields, same as any npm dependency. `pnpm -r`
  already respects the workspace dependency graph for build order. A library's `typecheck` script
  is therefore identical to its `build` script (both must emit, since downstream typecheck needs
  the `.d.ts` files) — full project-reference/composite wiring was evaluated and rejected as
  unnecessary complexity for this scale.
- **Intent engine is deterministic, not an LLM call.** Zero network dependency, zero hallucination
  risk, fully unit-testable offline. The `AIProvider` interface exists for Phase 4 to implement a
  real provider behind the same seam.
- **Idempotency-Key + best-effort outbox.** `POST /v1/enquiries` supports an `Idempotency-Key`
  header (stored + replayed). The BullMQ enqueue happens _after_ the DB transaction commits, which
  is a known at-least-once/best-effort gap closed by the transactional outbox in Phase 3.
- **Tenant isolation is application-level only.** Every repository function takes `tenantId`
  explicitly; Postgres Row Level Security (the DB-level backstop) is Phase 2/6 scope per
  `MASTER-PLAN.md`.
- **CSRF primitive shipped but not mounted.** The API is stateless (no cookie session yet), so
  there is nothing for CSRF to protect. The double-submit primitive is implemented and unit-tested
  so Phase 5+ (once an admin session exists) wires it in rather than building it under pressure.
- **Playwright via Fastify `inject()` + Next.js `webServer`,** not Supertest — Fastify's built-in
  request injection needs no extra dependency and is the framework's idiomatic testing path.
- **Pinned dependency majors** chosen for API stability rather than the newest available: Prisma 6
  (classic engine, no driver-adapter migration), zod 3, ioredis 5, BullMQ 5, Next 15 / React 19,
  Playwright 1.6x. All verified to install and interoperate correctly together.

## 4. What was built

### Packages

`config`, `domain`, `ai`, `security`, `observability`, `contracts`, `db`, `testing` — see
`docs/ARCHITECTURE.md` for responsibilities.

### Apps

- `apps/api` — Fastify 5 + Zod type provider, OpenAPI at `/docs`, `/health` + `/live` + `/ready`,
  helmet/CORS/rate-limit, request correlation, structured error envelope, `POST /v1/enquiries` +
  `GET /v1/enquiries/:id`.
- `apps/worker` — BullMQ worker consuming `post-enquiry-processing`, idempotent processor.
- `apps/web` — Next.js App Router enquiry form (Emerald & Copper design tokens), a server-side
  Route Handler proxy (`/api/enquiries`) using the SSRF-safe fetch wrapper, original components
  (`Monogram`, `GlassCard`, `CopperCard`, `PillButton`, `StatusChip`) matching
  `docs/DESIGN-SYSTEM.md` — no copyrighted assets copied.

### Infra / CI

`docker-compose.yml` (postgres, redis), `.github/workflows/ci.yml` (full gate pipeline),
`.github/workflows/security.yml` (dependency audit, gitleaks, Semgrep).

## 5. APIs

| Method | Path                            | Purpose                                                   |
| ------ | ------------------------------- | --------------------------------------------------------- |
| GET    | `/health`                       | liveness + build/observability status                     |
| GET    | `/live`                         | liveness + uptime                                         |
| GET    | `/ready`                        | readiness (Postgres + Redis)                              |
| POST   | `/v1/enquiries`                 | submit a customer message, get back the recognized intent |
| GET    | `/v1/enquiries/:conversationId` | fetch a conversation with its messages + intents          |
| GET    | `/docs`                         | OpenAPI / Swagger UI                                      |
| POST   | `/api/enquiries` (web)          | Next.js proxy to the API above                            |

Full request/response schemas: `packages/contracts/src/enquiry.ts`, `health.ts`; live OpenAPI doc
generated by `fastify-type-provider-zod` at `/docs`.

## 6. Database schema

`Tenant`, `Conversation` (`Channel` enum: WHATSAPP/WEB/EMAIL), `Message`, `IntentRecord`
(`IntentType` × 10 values, `IntentStatus`: RECOGNIZED/NEEDS_CLARIFICATION), `AuditEvent`,
`IdempotencyKey`. See `packages/db/prisma/schema.prisma` for the authoritative definition and
`packages/db/prisma/migrations/20260915222612_init/` for the applied migration.

## 7. Security decisions

See `docs/ARCHITECTURE.md` §Security posture for the full control-by-control table. Summary of
what's real vs. deferred:

**Implemented and tested:** input validation, request size limits, rate limiting, CORS allowlist,
secure headers/CSP, SSRF protection (allowlist + DNS-rebinding + no-redirect-follow), SQL
injection protection (Prisma parameterization, proven with real injection payloads against a real
Postgres), XSS protection (React escaping), secret isolation (env-only, log redaction), PII
classification/redaction, audit events on every mutation, application-level tenant isolation,
prompt-injection detection, outbound network allowlist.

**Shipped as a primitive but not yet wired into a live surface:** webhook HMAC signing (no real
webhook channel exists until Phase 5), CSRF double-submit (no cookie session exists until an admin
UI needs one).

**Explicitly deferred (documented, not silently skipped):** database-level Row Level Security
(Phase 2/6), separate least-privilege DB roles for api/worker/migrator (Phase 2/10), a real AI
provider behind an egress allowlist + tool-permission sandbox (Phase 4/6).

## 8. Test results

All commands below were run against real local PostgreSQL 16 + Redis 7 (no mocked infrastructure
for integration/security/e2e tests).

| Gate        | Command                 | Result                                                                                                     |
| ----------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| Typecheck   | `pnpm typecheck`        | ✅ 11/11 packages                                                                                          |
| Lint        | `pnpm lint`             | ✅ 0 errors, 0 warnings                                                                                    |
| Format      | `pnpm format:check`     | ✅ clean                                                                                                   |
| Unit        | `pnpm test:unit`        | ✅ 91 tests                                                                                                |
| Integration | `pnpm test:integration` | ✅ 21 tests (real Postgres + Redis + BullMQ)                                                               |
| Security    | `pnpm test:security`    | ✅ 21 tests (SQLi, XSS, prompt injection, SSRF, rate limit, CORS, headers, oversized body, no-leak errors) |
| E2E         | `pnpm test:e2e`         | ✅ 4 Playwright tests incl. an axe-core accessibility scan (0 serious/critical violations)                 |
| Build       | `pnpm build`            | ✅ every package + Next.js production build                                                                |

**Total: 137 automated tests, all passing**, plus a full production build.

Representative test cases exercised (per the brief's required list): normal enquiry, empty message,
extremely long message (10k+ chars), malicious HTML (`<script>`), SQL injection payload (`;
DROP TABLE`), prompt injection (`ignore previous instructions`), missing date, ambiguous date
("next week", bare weekday), invalid/unrecognized vehicle, unsupported/off-topic request,
multilingual input (Arabic script).

## 9. Known limitations

- **No real Docker daemon in this dev sandbox** — `docker-compose.yml` is provided and correct for
  normal local/CI use, but here local Postgres/Redis binaries were used directly for testing.
- **Transactional outbox not yet implemented** (Phase 3) — the BullMQ enqueue is best-effort after
  commit; a queue outage after a successful `POST /v1/enquiries` returns `502
UPSTREAM_UNAVAILABLE` even though the conversation was saved.
- **Tenant isolation is application-level only** — no Postgres RLS yet (Phase 2/6).
- **Intent lexicon is English-first** — Arabic/Hindi are language-_tagged_ correctly, but entity
  extraction (vehicle/location/date keywords) is English-only; non-English booking-shaped messages
  correctly fall through to `NEEDS_CLARIFICATION` rather than silently failing.
- **Single default tenant** — `DEFAULT_TENANT_ID` env var stands in for real tenant resolution
  (auth) until Phase 6.
- **Fastify `disableRequestLogging` is deprecated** (removed in Fastify 6, we're on 5.x) — noted,
  not urgent; our own `observabilityPlugin` already replaces Fastify's built-in request logging.
- **Swagger UI CSP** — the strict default CSP (`packages/security/headers.ts`) has not been
  specifically verified against `/docs`' inline-style needs; JSON API responses are unaffected.

## 10. Files created (by area)

- Root: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`,
  `.prettierrc.json`, `.env.example`, `.nvmrc`, `docker-compose.yml`, `.gitignore`
- `.github/workflows/ci.yml`, `.github/workflows/security.yml`
- `packages/{config,domain,ai,security,observability,contracts,db,testing}/**`
- `apps/{api,worker,web}/**`
- `docs/ARCHITECTURE.md`, `docs/phases/PHASE-01.md` (this file)

## 11. Files modified

- `docs/PHASE-CONTRACTS.json` — Phase 1 marked `FROZEN` with this file linked as evidence.

## 12. Migration status

One migration applied and verified: `20260915222612_init` (up-tested on both the dev and test
databases via `prisma migrate dev` / `prisma migrate deploy`; `migrate reset` was not exercised in
this sandbox because it requires Docker for the shadow database in CI — plain `migrate dev` against
a local Postgres was used instead, which exercises the same forward migration path).

## 13. Phase 2 contract (proposed inputs for the next phase)

Phase 2 — Core Domain & Data Model — should build on:

- `Tenant` already exists; extend with `User`, `Role`.
- `Conversation`/`Message`/`IntentRecord` already exist; Phase 2 adds `Customer`, `Vehicle`,
  `VehicleClass`, `AvailabilityBlock`, `Hold`, `PricingRule`, `Quote`, `Booking`, `Document`,
  `Payment`, `Invoice`, `EscalationCase`, `OutboxEvent` per `MASTER-PLAN.md` §5 Phase 2.
- Reuse `packages/domain`'s `AppError`, `TenantId`, `AuditWriter`/`PrismaAuditWriter` pattern —
  don't reinvent error handling or audit writing.
- Reuse `packages/testing`'s `createTestPrismaClient`/`truncateAllTables`/`seedTestTenants`
  pattern for new repositories' integration tests; extend `TABLES` in `packages/testing/src/db.ts`
  as new tables are added.
- Add Postgres RLS policies as SQL migrations (currently absent) once real multi-tenant auth
  exists — do not defer this again into Phase 3.

Do not start Phase 2 until asked.
