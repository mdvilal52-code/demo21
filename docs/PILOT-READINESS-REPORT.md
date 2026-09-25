# Pilot Readiness Report — Phases 1-8

**Snapshot commit:** `267daa8` (branch `claude/phase-4-whatsapp-sms-check-2ngbgx`)
**Date:** 2026-09-25
**Scope:** `PHASE-CONTRACTS.json` phases 1-8 only, as requested. Phases 9-10 (Observability/QA,
Infra/Release) and journey Steps 9-19 (Eligibility onward) are explicitly out of scope for this
report.

This document is a point-in-time audit, not a live status feed. `PHASE-CONTRACTS.json` remains the
single source of truth for phase status; if it and this report ever disagree, trust
`PHASE-CONTRACTS.json` and treat this report as stale. Re-run the verification in §7 before relying
on this document again after any further implementation work.

## 1. Purpose

This report exists to answer three questions that were asked directly, honestly, and with evidence
rather than assumptions:

1. Is the phase 1-8 pilot ready to handle real customers / real business problems today?
2. Specifically: do the Admin Dashboard, automatic CRM updates, and automatic email
   resend/handling exist?
3. Specifically: when the AI cannot handle something correctly, is there a mechanism that flags a
   human worker to step in?

**Short answers: No / No / No.** Details and evidence below.

## 2. Executive verdict

Only one narrow slice of the full 19-step, 10-phase system is real: a customer can message a real
WhatsApp number and have Steps 1-4 of the journey (Enquiry/Intent → Extract Dates & Location →
Determine Vehicle → Ask Missing Information) run automatically, with a scripted WhatsApp reply.
Nothing after Step 4 is automated, and three of the four things this report was specifically asked
to check (Admin Dashboard, CRM, human-escalation indication) do not exist in code at all. Email
does not exist as a channel at all (neither inbound nor outbound).

What **is** real is solid: Phases 1-4 are fully frozen with strong automated test coverage, and the
WhatsApp slice of Phase 5 follows the project's own non-negotiables correctly (no fake successes,
explicit `NOT_CONFIGURED` states, real idempotency, real signature verification, audited mutations).
The gap is not quality of what exists — it's the sheer amount of the master plan that does not exist
yet.

## 3. Phase-by-phase status (verified against `PHASE-CONTRACTS.json` + code)

| # | Phase | Contract status | What "done" actually means here |
|---|-------|------------------|----------------------------------|
| 1 | Foundation & Platform Skeleton + Enquiry/Intent (journey Step 1) | **FROZEN** | Monorepo, Fastify API, BullMQ worker, Next.js web shell, Postgres/Prisma, design tokens, CI. Intent recognition is a **deterministic keyword engine** (`RuleBasedIntentEngine`), not an LLM call. |
| 2 | Extract Dates & Location (Step 2) | **FROZEN** | Pickup/return date + location extraction and validation. English-only regex/heuristics, small fixed gazetteer. |
| 3 | Determine Vehicle (Step 3) | **FROZEN** | Maps a customer's wording to the real fleet catalog. Regex/edit-distance matching, not NLP; small fixed fleet. |
| 4 | Ask Missing Information (Step 4) | **FROZEN** | Generates one combined clarification question for whatever Steps 1-3 didn't resolve. Template-based, English-only. |
| 5 | Channels, Documents, Payments, CRM & Fulfilment | **IN_PROGRESS** | Only the WhatsApp inbound/outbound adapter + a hardcoded Step 1-4 pipeline runner is built (see `docs/PHASE-5.md`). Web chat, Email, Document pipeline, `PaymentProvider`, **CRM adapter**, delivery/return coordination, invoice PDF, and follow-up scheduler are all still **PENDING** — none of that code exists. |
| 6 | Security Engine & Zero Trust | **PENDING** | 0% started. No AuthN, no AuthZ/RBAC, no DB-level tenant isolation (RLS), no MFA, no field-level encryption, no anomaly detection. |
| 7 | **Admin Dashboard (Web)** | **PENDING** | 0% started. Zero dashboard routes/screens exist in `apps/web` — it only contains the customer-facing enquiry form from Phase 1. A design contract exists in `docs/DESIGN-SYSTEM.md` §5, but no implementation. |
| 8 | Customer Mobile App (PWA) | **PENDING** | 0% started. `apps/` contains only `api`, `web`, `worker` — no `apps/customer` directory exists at all. |

## 4. What was actually verified this session (not just read)

- `pnpm install` — clean.
- `pnpm typecheck` — **green, 12/12 packages/apps** (api, web, worker + 9 packages).
- `pnpm test:unit` — **green, 329/329 tests**, across every package and app.
- Integration/security/e2e suites were **not** re-run (they need live Postgres/Redis/Playwright
  Chromium and take significantly longer); `docs/PHASE-5.md` §8 records them last green at 498
  total automated tests. Typecheck + unit alone don't prove feature correctness end-to-end — only
  that nothing regressed at the type/unit level since that freeze.
- Every route file in `apps/api/src/routes/**` was enumerated: `enquiries`, `temporal`, `vehicle`,
  `missingInfo`, `health`, `privacy`, and the WhatsApp webhook. No admin, CRM, or email route exists.
- Every file in `packages/security/src/**` was enumerated: SSRF-safe fetch, resilience
  (timeout/circuit-breaker/rate-limiter), CSRF, webhook signature verification, CORS, secure headers.
  **No authentication or authorization module exists anywhere in the codebase.**
- The Prisma schema (`packages/db/prisma/schema.prisma`) was read in full: `Tenant`, `Conversation`,
  `Message`, `IntentRecord`, `AuditEvent`, `IdempotencyKey`, `DateLocationExtraction`, `Vehicle`,
  `VehicleDetermination`, `MissingInfoCheck`. No `Customer`, `Booking`, `Payment`, `Document`,
  `Quote`, `Invoice`, or `EscalationCase` model exists yet.
- Full-text search for `crm`, `escalat`, `nodemailer`/`sendgrid`/`smtp`, and any admin route across
  `apps/` and `packages/` (excluding tests): **zero matches** for actual implementation in every
  case.
- `.env.example` and `render.yaml` were read in full: no AI provider key (Anthropic/OpenAI), no CRM
  key, no email provider key, no payment provider key is wired anywhere — only WhatsApp, Postgres,
  and Redis. This independently confirms the codebase-search findings above.
- `git branch -a`: **exactly one branch exists**, `claude/phase-4-whatsapp-sms-check-2ngbgx` (local
  and its `origin` remote), nothing else to reconcile.

## 5. The specific questions asked

### 5.1 Admin Dashboard

**Does not exist.** `apps/web/src/app` has exactly one page (the customer enquiry form) plus its
API proxy route. Phase 7 owns this and is `PENDING`. Per `PHASE-CONTRACTS.json`, Phase 7
`dependsOn: [6]` — the project's own plan requires Security (Phase 6) before the dashboard, because
the dashboard is where bookings, customers, escalations, and revenue data would be exposed.

### 5.2 CRM auto-update

**Does not exist.** No CRM adapter, no `Customer` model, no upsert-on-booking logic anywhere. This
is explicitly listed as a `PENDING` deliverable of Phase 5 (the current in-progress phase) in
`PHASE-CONTRACTS.json`.

### 5.3 Email auto-resend

**Does not exist, in either direction.** There is no inbound email webhook and no outbound email
sending code anywhere in the repository (no mail library is even a dependency). WhatsApp is the only
working channel. This is also an explicitly `PENDING` Phase 5 deliverable.

### 5.4 "AI fails → human worker is indicated"

**Does not exist as a mechanism.** There is no escalation queue, no `EscalationCase` record, no
notification, and no admin visibility of any kind. Concretely, today, when the rule-based engine
cannot classify a customer's message (or a conversation reaches `NOT_APPLICABLE`), the system just
sends the same generic scripted WhatsApp reply again — it does not notify anyone, and there is no
screen where a human could even see that a customer is stuck. `docs/MASTER-PLAN.md` names a
Human Escalation component (tiers T1-T4) and Phase 7's dashboard spec even reserves a "Human
Escalations" stat tile and an "Escalation queue" screen for it — but under the actual phase
numbering that was followed (journey-step granularity for Phases 1-4, then the WhatsApp slice of
Phase 5), no phase has yet delivered this. It needs to be explicitly scheduled, not assumed to be
part of a phase already in progress.

## 6. Live deployment reality (Render + Vercel)

Commit history and `render.yaml` show this has already been deployed and debugged against a real
WhatsApp webhook, not just run locally. Three things matter for real-world readiness:

- **The background worker is disabled in production** (`render.yaml`, Render's free plan has no
  "worker" service type). The BullMQ post-enquiry job is enqueued but never consumed in the live
  deployment — `conversation.processedAt` and its audit event never get written, though every HTTP
  path (including the WhatsApp webhook) still works because that part doesn't depend on the worker.
- **No authentication exists on any API endpoint.** `POST /v1/enquiries` and every other route are
  reachable by anyone who has the URL, not only through the website or WhatsApp — CORS only blocks
  browser-based cross-origin calls, not direct HTTP clients. This is expected, given Phase 6 hasn't
  started, but it means the live deployment today has no access control at all.
- **Redis eviction risk**: BullMQ needs `maxmemory-policy=noeviction`; the free-tier default
  (`allkeys-lru`) can silently drop queued job keys under memory pressure. Both services log a
  startup warning when this is misconfigured.
- WhatsApp credentials are optional (`sync: false` in `render.yaml`) — whether real Meta credentials
  are currently filled in on the live Render dashboard cannot be confirmed from the repo alone, but
  commit `4520f06` ("log signature-mismatch diagnostics on the live webhook") indicates real webhook
  traffic has been debugged against this deployment.

## 7. Ranked list of what will cause real-life problems (highest impact first)

1. **No human escalation/visibility.** A confused or non-English-speaking customer, or one asking
   about price/documents/support, gets the same scripted reply indefinitely with no human ever
   notified.
2. **No Admin Dashboard.** The business cannot see bookings, conversations, or anything else without
   querying the database directly.
3. **No CRM.** No durable customer profile/history beyond raw conversation rows.
4. **No email channel.** Any customer who emails instead of WhatsApp-ing gets no response at all.
5. **No authentication on the API.** Publicly callable by anyone with the URL, not just your own
   channels.
6. **A booking can never actually complete.** Pricing, documents, payments, and confirmation (Steps
   5-19) don't exist yet — the automated part stops after Step 4 gathers information.
7. **The background worker is disabled in the live deployment**, so the one asynchronous job that
   does exist silently never runs there.
8. **The "AI" is keyword/regex matching, not a language model** — by design, for zero hallucination
   risk, but it means genuinely novel phrasing, non-English messages, or off-script questions get no
   real answer, only a generic fallback or a repeated clarification prompt.
9. **Single hardcoded tenant, small fixed fleet/vocabulary** — not yet wired for a real multi-vehicle,
   multi-location business without extending fixed lists in code.

## 8. What is genuinely solid (credit where due)

- Phases 1-4 are frozen with real, passing automated tests (typecheck + 329 unit tests reconfirmed
  live this session), not just claimed in documentation.
- The `NOT_CONFIGURED`/`UNAVAILABLE` discipline from `PHASE-EXECUTION-PROTOCOL.md` is followed
  correctly everywhere it was checked — the AI provider seam, the WhatsApp provider, OpenTelemetry —
  none of them fake a working integration when credentials are absent.
- The WhatsApp slice has real signature verification, atomic claim-before-work idempotency (proven
  under genuine concurrency, per `docs/PHASE-5.md` §3/§8), audited replies, and SSRF-restricted
  egress to exactly one host.
- Every mutation observed is audited; every phase's regression suite was re-run green before
  freezing, per each phase doc's own test tables.

## 9. Open decisions for the user (not to be made unilaterally)

These were already flagged in `docs/PHASE-5.md` §13 and remain unresolved:

1. Whether to broaden Phase 1's intent lexicon so naming a specific vehicle alone (no booking verb)
   counts as booking evidence.
2. What comes next after this report: continuing Phase 5's remaining deliverables (CRM, Email,
   Documents, Payments), building the Human Escalation mechanism (not clearly owned by any phase
   under the current numbering), or Journey Step 5 (Eligibility).
3. Whether Phase 6 (Security) must precede Phase 7 (Admin Dashboard), as `PHASE-CONTRACTS.json`'s own
   `dependsOn` graph requires, or whether that order should be deliberately overridden and the risk
   of an unauthenticated dashboard accepted.

Do not start building any of the above until the user has explicitly chosen.
