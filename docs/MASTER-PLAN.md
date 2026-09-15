# AI Concierge — Master Plan

Luxury car-rental AI concierge (Dubai, AED). Customers reach the business over WhatsApp, Web and
Email; an AI orchestrator drives a 19-step rental journey with human escalation, zero-trust
security, an admin dashboard and a customer mobile app.

Companion documents

- `docs/PHASE-EXECUTION-PROTOCOL.md` — mandatory rules for every phase
- `docs/PHASE-CONTRACTS.json` — machine-readable phase status, deliverables, acceptance
- `docs/DESIGN-SYSTEM.md` — emerald & copper tokens, components, screen contracts
- `docs/phases/PHASE-NN.md` — one document per completed phase

## 0. Non-negotiables (every phase)

1. Follow the Phase Execution Protocol before, during and after every change.
2. Gate pipeline green before a phase is FROZEN:
   typecheck → lint → unit → integration → security → e2e → build → code review → architecture review → regression.
3. Never fake functionality. Missing external credentials → explicit `NOT_CONFIGURED` / `UNAVAILABLE`, never a fake success.
4. Never trust AI output, customer input, external API input or uploaded documents. Zod at every boundary.
5. UI/UX must match the reference design (deep emerald + brushed copper) — see `DESIGN-SYSTEM.md`.
6. Preserve working functionality; delete only after confirming no active dependency.

## 1. Target architecture

```
                         ┌──────────────────────────┐
                         │        CUSTOMER          │
                         │ WhatsApp / Web / Email   │
                         └────────────┬─────────────┘
                                      ▼
                    ┌─────────────────────────────────┐
                    │      AI CONCIERGE GATEWAY       │
                    │ Auth • Rate Limit • DLP • WAF   │
                    └───────────────┬─────────────────┘
                                    ▼
                    ┌─────────────────────────────────┐
                    │     EVENT / WORKFLOW ENGINE     │
                    │ State Machine • Idempotency     │
                    │ Retry • Timeout • Compensation  │
                    └───────────────┬─────────────────┘
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
 ┌────────────────┐       ┌────────────────┐       ┌────────────────┐
 │ AI ORCHESTRATOR│       │HUMAN ESCALATION│       │ SECURITY ENGINE│
 │Intent/Reasoning│       │ Tier 2/3/4     │       │ Zero Trust     │
 └───────┬────────┘       └───────┬────────┘       └───────┬────────┘
         └────────────────────────┼────────────────────────┘
                                  ▼
                    ┌────────────────────────────┐
                    │     DOMAIN SERVICES        │
                    │ Booking • Pricing • Docs   │
                    │ CRM • Payment • Delivery   │
                    │ Return • Invoice • Followup│
                    └──────────────┬─────────────┘
                                   ▼
                    ┌────────────────────────────┐
                    │       DATA LAYER           │
                    │ PostgreSQL • Redis • Object│
                    │ Storage • Search • Audit   │
                    └──────────────┬─────────────┘
                                   ▼
                    ┌────────────────────────────┐
                    │    OBSERVABILITY + QA      │
                    │ Logs • Metrics • Traces    │
                    │ AI Evaluation • Security   │
                    │ Regression • Anomaly Engine│
                    └──────────────┬─────────────┘
                                   ▼
                         AUTOMATIC QA  PASS / FAIL
                          PASS → next phase
                          FAIL → diagnose → fix → test → loop
```

| Layer                   | Responsibility                                                                                               | Lives in                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Customer channels       | WhatsApp, Web chat, Email adapters, unified inbound message model                                            | `packages/channels`, `apps/api` (webhooks) |
| AI Concierge Gateway    | authn, rate limiting, WAF rules, DLP redaction, request envelope                                             | `apps/api`, `packages/security`            |
| Event / Workflow Engine | journey state machine, idempotency keys, retry, timeouts, saga compensation, transactional outbox            | `packages/workflow`, `apps/worker`         |
| AI Orchestrator         | intent, entity extraction, reasoning, tool calls behind permission gates, prompt registry, evaluation        | `packages/ai`                              |
| Human Escalation        | tiers 2/3/4, queues, SLA timers, handoff context, approvals                                                  | `packages/domain`, `apps/web`              |
| Security Engine         | zero trust: RBAC+ABAC policy engine, tenant isolation, AI sandbox, egress allowlist, anomaly response        | `packages/security`                        |
| Domain Services         | booking, pricing, documents, CRM, payment, delivery, return, invoice, follow-up                              | `packages/domain`, `packages/db`           |
| Data Layer              | PostgreSQL (Prisma + RLS), Redis (BullMQ, cache), S3-compatible storage, Postgres FTS (pluggable), audit log | `packages/db`, `infra/compose`             |
| Observability + QA      | OpenTelemetry logs/metrics/traces, AI evaluation, security regression, anomaly engine, Automatic QA gate     | `packages/observability`, `packages/qa`    |
| Interfaces              | Admin dashboard, customer mobile app (PWA)                                                                   | `apps/web`, `apps/customer`                |

## 2. Repository layout (pnpm workspaces + Turborepo)

```
.
├── apps/
│   ├── api/                 Fastify · REST + webhooks · OpenAPI · Zod type provider
│   ├── worker/              BullMQ workers · workflow timers · AI jobs · outbox relay
│   ├── web/                 Next.js admin dashboard (Phase 7)
│   └── customer/            Next.js mobile-first PWA for customers (Phase 8)
├── packages/
│   ├── core/                ids, Result/AppError, money, time, common Zod schemas
│   ├── db/                  Prisma schema, migrations, RLS policies, seed, repositories
│   ├── domain/              domain services (booking, pricing, documents, payment, …) + DI wiring
│   ├── workflow/            typed journey state machine, transitions, saga, idempotency
│   ├── ai/                  AIProvider abstraction, adapters, prompt registry, tools, evaluators
│   ├── channels/            WhatsApp / Web / Email adapters + outbound templates
│   ├── security/            authn (OIDC), authz (RBAC+ABAC), tenant context, DLP, egress allowlist
│   ├── observability/       OTel bootstrap, pino logger, metrics helpers
│   ├── qa/                  Automatic QA engine, journey evaluators, anomaly rules
│   ├── ui/                  design tokens + Emerald&Copper components (shadcn/ui based)
│   └── config/              tsconfig / eslint / prettier / tailwind presets
├── infra/
│   ├── compose/             docker-compose (postgres, redis, minio, otel-collector, grafana/tempo)
│   ├── docker/              Dockerfiles per app
│   └── terraform/           cloud infrastructure (Phase 10)
├── docs/                    plans, contracts, protocol, design system, phase docs, ADRs
├── .github/workflows/       ci.yml (mandatory gates), security.yml, release.yml
├── CLAUDE.md                pointer to the protocol for every AI session
├── package.json · pnpm-workspace.yaml · turbo.json · .env.example
```

## 3. Tech stack (locked)

| Area           | Choice                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend       | Next.js (App Router) + TypeScript, Tailwind CSS, shadcn/ui, React Hook Form, Zod                                                                                      |
| Backend        | Node.js + TypeScript, Fastify, REST + Webhooks, OpenAPI (generated from Zod route schemas)                                                                            |
| Database       | PostgreSQL + Prisma (migrations, RLS policies as SQL migrations)                                                                                                      |
| Cache / Jobs   | Redis + BullMQ                                                                                                                                                        |
| Object storage | S3-compatible (MinIO locally)                                                                                                                                         |
| AI             | `AIProvider` abstraction — OpenAI / Anthropic / other adapters, `NotConfiguredProvider`; no lock-in                                                                   |
| Auth           | OIDC / OAuth2, short-lived access tokens (≤15 min) + rotating refresh, RBAC + ABAC policy engine                                                                      |
| Observability  | OpenTelemetry (traces, metrics), structured JSON logs (pino), correlation ids                                                                                         |
| Testing        | Vitest (unit), Supertest (HTTP), Testcontainers (integration), Playwright (e2e), fast-check (property tests), Semgrep (SAST), dependency scanning, gitleaks (secrets) |
| Infra          | Docker, Docker Compose (local), Terraform, GitHub Actions CI/CD with mandatory gates                                                                                  |

## 4. Customer journey → workflow states

Owner: **AI** = AI orchestrator proposes, deterministic code validates · **SYS** = deterministic service · **HUMAN** = escalation tier.

| #   | Step                     | State                           | Owner            | Key logic                                                                                        | Side effects / compensation                                         |
| --- | ------------------------ | ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 01  | Enquiry / Intent         | `ENQUIRY_RECEIVED`              | AI               | classify intent (rental, support, complaint, other); open/resume journey                         | create `journey`, `conversation`; audit                             |
| 02  | Extract dates + location | `EXTRACTING_REQUIREMENTS`       | AI→SYS           | extract pickup/return datetime, pickup/return location; normalise to Asia/Dubai; validate ranges | update journey context                                              |
| 03  | Determine vehicle        | `VEHICLE_SELECTION`             | AI→SYS           | map preference to fleet class / model; budget hint                                               | none                                                                |
| 04  | Ask missing information  | `COLLECTING_MISSING_INFO`       | AI               | generate targeted questions for missing required fields; loop until complete or timeout          | timeout 24h → `EXPIRED`                                             |
| 05  | Eligibility              | `ELIGIBILITY_CHECK`             | SYS              | tenant rules: min age per class, licence type (UAE / IDP), residency, blocklist, deposit ability | fail → `DECLINED` + reason; may escalate T3 for exception           |
| 06  | Availability             | `AVAILABILITY_CHECK`            | SYS              | calendar check with buffer; place soft hold (TTL)                                                | hold created; compensation releases hold                            |
| 07  | Alternatives             | `OFFERING_ALTERNATIVES`         | AI→SYS           | if unavailable: nearest dates / similar class / upgrade options from real availability           | none                                                                |
| 08  | Quote                    | `QUOTE_ISSUED`                  | SYS              | pricing engine: base rate, duration tiers, extras, deposit, VAT 5 %; quote expiry                | quote record; expiry timer → `QUOTE_EXPIRED`, release hold          |
| 09  | Documents                | `DOCUMENTS_REQUESTED`           | AI→SYS           | request passport, licence, Emirates ID / visa; presigned uploads                                 | timers, reminders                                                   |
| 10  | Document verification    | `DOCUMENTS_VERIFYING`           | SYS→HUMAN        | MIME/size/AV checks, extraction interface, checklist; manual review queue (T2)                   | reject → back to 09                                                 |
| 11  | Payment instructions     | `PAYMENT_INSTRUCTED`            | SYS              | payment link or bank instructions via `PaymentProvider`; deposit hold                            | webhook reconciliation; timeout → reminder → `EXPIRED`              |
| 12  | CRM update               | `CRM_UPDATED`                   | SYS              | upsert customer, booking, timeline into CRM adapter (internal by default)                        | retry with backoff                                                  |
| 13  | Human approval           | `AWAITING_HUMAN_APPROVAL`       | HUMAN T3         | manager approves booking (fraud/high value/exception); SLA timer                                 | reject → `DECLINED` with compensation (refund intent, release hold) |
| 14  | Confirmation             | `CONFIRMED`                     | SYS→AI           | convert hold to booking, send confirmation with details                                          | booking confirmed; calendar block                                   |
| 15  | Delivery coordination    | `DELIVERY_SCHEDULED`            | AI→SYS→HUMAN T2  | slot, address, driver assignment, handover checklist, photos                                     | reschedule flow                                                     |
| 16  | On-rental support        | `ON_RENTAL`                     | AI (T2 fallback) | Q&A, extension requests (re-quote), incident intake                                              | extension = sub-journey                                             |
| 17  | Return coordination      | `RETURN_SCHEDULED` → `RETURNED` | AI→SYS→HUMAN T2  | slot, inspection checklist, damage/fuel/km capture                                               | disputes → T3                                                       |
| 18  | Final invoice            | `FINAL_INVOICE_ISSUED`          | SYS              | extras, fines, damage, deposit release; PDF invoice; payment/refund                              | refund via provider                                                 |
| 19  | Post-rental follow-up    | `FOLLOW_UP_SENT` → `CLOSED`     | AI→SYS           | thank-you, review request, next-offer; scheduled job                                             | none                                                                |

Overlay states: `ESCALATED(tier, reason)` (resumable), `CANCELLED`, `DECLINED`, `EXPIRED`.
Every transition: guarded, validated, transactional, idempotent, audited, emits an outbox event.

Escalation tiers: **T1** AI · **T2** Ops agent (documents, delivery, return, support) · **T3** Manager (approval, pricing exceptions, disputes) · **T4** Security / Compliance (fraud, abuse, data incidents).

## 5. Phases

Status values: `PENDING` → `IN_PROGRESS` → `FROZEN`. A phase is FROZEN only when its acceptance criteria and the full gate pipeline are green and `docs/phases/PHASE-NN.md` is written.

### Phase 1 — Foundation & Platform Skeleton

Goal: a runnable, tested, CI-gated monorepo with API, worker, web shell, database, cache, storage, observability bootstrap and the design tokens — the base every later phase builds on.

Deliverables

- Monorepo: pnpm workspaces, Turborepo, strict TypeScript project references, ESLint + Prettier, Vitest, Playwright, `.env.example`, `.nvmrc`.
- `apps/api`: Fastify with Zod type provider, OpenAPI at `/docs`, `/health` + `/ready`, request-id + correlation, pino structured logs, OTel bootstrap, config loader (env → Zod, fail fast), `AppError` envelope, graceful shutdown.
- `apps/worker`: BullMQ worker bootstrap, heartbeat job, shared config/logging.
- `apps/web`: Next.js App Router + Tailwind + shadcn/ui + Emerald&Copper tokens; themed shell page (TopBar + one CopperCard + one GlassCard) proving the design system.
- `packages/core`, `packages/config`, `packages/observability`, `packages/ui` (tokens + Monogram, CopperCard, GlassCard, PillButton), `packages/db` (Prisma with `Tenant`, `User`, `AuditEvent`; migration + seed).
- `infra/compose`: postgres, redis, minio, otel-collector, grafana/tempo (or jaeger).
- CI: `.github/workflows/ci.yml` running every gate in order; `security.yml` (pnpm audit, gitleaks, semgrep).
- Docs: `docs/ARCHITECTURE.md`, `docs/phases/PHASE-01.md`, contracts updated.

Acceptance

- `pnpm install && docker compose up -d && pnpm db:migrate && pnpm dev` starts api, worker, web.
- `GET /health` → 200 with build info; `GET /docs` serves OpenAPI.
- Web shell renders with the design tokens (visual snapshot committed).
- All gates pass locally and in CI on a clean clone.

### Phase 2 — Core Domain & Data Model

Goal: the complete persistent model and domain services for a luxury rental business, with tenant isolation, audit, transactions and structured errors.

Deliverables

- Prisma models: Tenant, User, Role, Customer, Vehicle, VehicleClass, AvailabilityBlock, Hold, PricingRule, Quote, Booking, Document, Payment, Invoice, Conversation, Message, EscalationCase, AuditEvent, OutboxEvent, IdempotencyKey; every business table carries `tenant_id`; RLS baseline policies as SQL migrations.
- Repositories + domain services (`packages/domain`) with a DI container; transaction helper; optimistic versioning.
- Pricing engine (integer fils, VAT, duration tiers, extras, deposit) with property-based tests.
- Availability service with holds and TTL release job.
- Admin REST endpoints (CRUD for fleet, pricing, customers, bookings) behind an authz stub; OpenAPI updated.
- Seed: Dubai demo fleet (e.g. Lamborghini Urus, Rolls-Royce Cullinan, G63), pricing rules, a demo tenant.

Acceptance: migrations up/down/up clean; integration tests via Testcontainers; RLS cross-tenant tests fail closed; pricing property tests green.

### Phase 3 — Event / Workflow Engine

Goal: the 19-step journey as a typed, persisted, idempotent state machine with retries, timeouts and compensation.

Deliverables

- `packages/workflow`: state/transition table from §4, guards, effects, context schema (Zod), version-checked persistence, `ESCALATED` overlay, resume.
- Idempotency middleware (HTTP + jobs + webhooks) backed by `IdempotencyKey`.
- Transactional outbox → BullMQ relay; retry policies; delayed jobs for timeouts (quote expiry, document reminders, approval SLA).
- Saga compensation (release hold, void quote, refund intent, notify).
- Journey API: start, advance, escalate, resume, cancel; journey timeline endpoint.

Acceptance: exhaustive transition tests; property test "no invalid transition reachable"; crash-recovery test (worker killed mid-transition leaves consistent state); journey timeline is fully audited.

### Phase 4 — AI Orchestrator & Provider Abstraction

Goal: AI drives the journey safely — proposes, never decides.

Deliverables

- `AIProvider` interface (chat, structured output, optional embeddings); adapters `anthropic`, `openai`, `NotConfiguredProvider`; selection by env; timeouts, retries, cost/latency telemetry.
- Prompt registry (versioned per step), structured outputs validated by Zod, refusal/low-confidence handling, PII redaction (DLP hook) before provider calls.
- Step agents: intent classification, requirement extraction, missing-info questions, alternatives narration, quote explanation, on-rental support, follow-up copy.
- Tool-calling with permission gates: each tool declares allowed journey states and roles; side-effecting tools execute only through the workflow engine.
- Human escalation service: tiers 2/3/4, reasons, SLA timers, handoff context, resume.
- AI evaluation harness: golden conversations, recorded provider fixtures, deterministic offline runs, thresholds enforced in CI.

Acceptance: journey steps 01–08 run end-to-end with a provider or degrade explicitly to `NOT_CONFIGURED`; injection test suite (prompt injection cannot trigger a tool outside its allowed state); eval suite ≥ thresholds.

### Phase 5 — Channels, Documents, Payments, CRM & Fulfilment

Goal: every external touchpoint behind a clean interface; the full 19-step journey runnable.

Deliverables

- Gateway inbound model; WhatsApp adapter (Meta Cloud API webhooks with signature verification), Web chat (REST + SSE), Email adapter (inbound webhook + outbound interface); outbound templates, rate limits, delivery receipts; each adapter has `NOT_CONFIGURED`.
- Document pipeline: presigned S3 uploads, MIME/size validation, AV-scan interface, extraction interface, verification checklist, T2 manual review queue.
- `PaymentProvider` interface + payment instructions + webhook reconciliation + refunds; `NOT_CONFIGURED` → explicit manual-instruction path flagged in admin.
- CRM adapter interface (internal default), delivery/return coordination (slots, assignment, checklists, photos), invoice PDF generation, follow-up scheduler.

Acceptance: full journey 01–19 passes e2e with test doubles inside tests only; production wiring shows real provider status per adapter in admin Settings; webhook signature and replay tests.

### Phase 6 — Security Engine & Zero Trust

Goal: the security architecture from the security diagram, verified by tests.

```
Internet → WAF/Rate Limit → API Gateway → Authentication → Authorization → Tenant Isolation
        → Domain Service → (AI Sandbox → Tool Permission → Egress Allowlist) → Database Policy → Encrypted Data
```

Deliverables

- Edge: Redis-backed rate limiting, WAF rules (body size, schema, IP lists, bot signals).
- AuthN: OIDC/OAuth2, ≤15-min access tokens, rotating refresh, step-up/MFA for admin roles.
- AuthZ: RBAC roles + ABAC policy engine (tenant, ownership, journey state, tier) enforced in one middleware and in services.
- Tenant isolation: RLS on every table, per-connection tenant context, cross-tenant negative tests.
- AI sandbox: tool permission matrix, egress allowlist for outbound HTTP, injection defences, output DLP.
- Data: TLS, field-level encryption for PII (passport/licence numbers), secrets management, key rotation runbook.
- Detection & response: anomaly rules (velocity, geo, privilege change, mass export), automatic restricted response (session revoke, step-up, freeze booking), security event stream, T4 escalation.
- CI: Semgrep, dependency scan, gitleaks, Trivy image scan, ZAP baseline against ephemeral env.
- `docs/SECURITY-MODEL.md` (STRIDE threat model) + compromised-account kill-chain test.

Acceptance: kill-chain test proves each layer contains a compromised account; authz matrix tests; all scanners green with zero critical.

### Phase 7 — Admin Dashboard (Web)

Goal: the dashboard wireframe, pixel-faithful to the design system.

Deliverables: Home (TopBar, JourneyStepper with live counts, StatTiles: Active Bookings, AI Automation %, Human Escalations, Revenue AED), Bookings, Journeys (live state + timeline), Escalation queue (tiers, SLA), Document review, Customers, Fleet & availability, Pricing, Payments/Invoices, Audit log, Settings (provider status CONFIGURED / NOT_CONFIGURED). Real-time via SSE. Role-aware navigation. Playwright e2e + visual regression against the reference.

### Phase 8 — Customer Mobile App (PWA)

Goal: the mobile wireframe and reference image, pixel-faithful.

Deliverables: Home (Monogram, AI CONCIERGE, Upcoming Rental CopperCard, Documents GlassCard, Payment CopperCard, CONTACT AI), Chat with AI (web channel), Bookings, Document upload with camera, Payments, Profile, BottomTabBar. Installable PWA, offline shell, push-notification interface (`NOT_CONFIGURED` until keys). Visual regression against `docs/design/reference/`.

### Phase 9 — Observability, AI Evaluation & Automatic QA

Goal: the bottom of the architecture diagram — measurable, self-checking system.

Deliverables: OTel end-to-end (api, worker, web) with journey-id propagation; metrics (automation rate, escalation rate, step conversion, latency, AI cost); Grafana dashboards in compose; AI evaluation suite expanded (accuracy, safety, hallucination, tone); security regression suite; anomaly engine; Automatic QA engine producing PASS/FAIL per journey and per release with a report artifact in CI.

### Phase 10 — Infrastructure, CI/CD & Release

Goal: production-ready delivery.

Deliverables: Terraform (network, Postgres, Redis, object storage, container runtime, secrets, WAF), dev/staging/prod environments, CI/CD with mandatory gates and manual prod approval, migration strategy, backups/DR drill, runbooks, SLOs/alerts, release-freeze checklist.

## 6. Cross-cutting engineering standards

- Typed interfaces everywhere; Zod at every boundary (HTTP, queue payloads, AI outputs, env, webhooks).
- DI container per app; services receive dependencies; no global singletons.
- Idempotency: every command, job and webhook carries an idempotency key stored with the response hash.
- Transactions: every state change in one DB transaction with optimistic version check; outbox rows written in the same transaction.
- Structured errors: `AppError { code, httpStatus, message, details?, cause? }` with an enum of stable codes; internals never leak.
- Audit events on every mutation: tenant, actor, action, entity, before/after, request id, ip.
- Least privilege: separate DB roles (api, worker, migrator); tenant context per connection; tokens scoped to tenant + role.
- Providers behind interfaces with a `NotConfigured` implementation surfaced in admin Settings.
- Money in integer minor units (fils) with currency code; never floats. Time stored UTC; tenant timezone `Asia/Dubai` at the edges.
- i18n-ready copy from Phase 1 (English first; Arabic/RTL ready).

## 7. Quality gates — commands

| Gate                | Command                          | Tooling                                                |
| ------------------- | -------------------------------- | ------------------------------------------------------ |
| Typecheck           | `pnpm typecheck`                 | `tsc -b`                                               |
| Lint                | `pnpm lint`                      | ESLint + Prettier check                                |
| Unit                | `pnpm test:unit`                 | Vitest, fast-check                                     |
| Integration         | `pnpm test:integration`          | Vitest + Testcontainers + Supertest                    |
| Security            | `pnpm test:security`             | Semgrep, `pnpm audit`, gitleaks, authz/injection tests |
| E2E                 | `pnpm test:e2e`                  | Playwright                                             |
| Build               | `pnpm build`                     | Turborepo                                              |
| Code review         | `/code-review` + phase checklist | —                                                      |
| Architecture review | checklist vs §1 and §6           | —                                                      |
| Regression          | `pnpm test` on the final commit  | full suite                                             |

## 8. Definition of Done (per phase)

- [ ] All deliverables in `PHASE-CONTRACTS.json` implemented
- [ ] All acceptance criteria demonstrated (commands / screenshots in the phase doc)
- [ ] All ten gates green locally and in CI
- [ ] Migrations verified up / down / up on a fresh database
- [ ] No fake success paths; every unavailable provider reports `NOT_CONFIGURED`
- [ ] Security checklist for the phase completed
- [ ] `docs/phases/PHASE-NN.md` written, `ARCHITECTURE.md` updated if changed
- [ ] Phase marked `FROZEN` in `PHASE-CONTRACTS.json`

## 9. Decisions & assumptions (confirm or override before Phase 1)

| #   | Topic                | Assumption                                                                                                                                |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Product / brand name | Product: **AI Concierge**; brand mark from the reference: **GLOBAL CONNECT** with the "N" monogram. Both configurable per tenant.         |
| 2   | Customer app         | Next.js mobile-first **PWA** (stack has no native runtime). Native wrapper (Expo/Capacitor) can be added later without rewriting screens. |
| 3   | Multi-tenancy        | Multi-tenant from day one (tenant id + RLS); first tenant is the Dubai business.                                                          |
| 4   | Languages            | English first, Arabic (RTL) supported by the i18n layer from Phase 1, translations in Phase 8.                                            |
| 5   | Currency / tax       | AED, VAT 5 %, integer fils.                                                                                                               |
| 6   | WhatsApp             | Meta Cloud API adapter first; Twilio adapter possible behind the same interface.                                                          |
| 7   | Payments             | `PaymentProvider` interface; first adapter chosen at Phase 5 (Stripe / Network International / Tap).                                      |
| 8   | AI providers         | Anthropic and OpenAI adapters; no provider is required to boot — `NOT_CONFIGURED` is a valid state.                                       |
| 9   | Workflow engine      | Custom typed state machine in `packages/workflow` (XState v5 acceptable alternative; decided at Phase 3 start).                           |
| 10  | Package manager      | pnpm + Turborepo; Node LTS.                                                                                                               |
