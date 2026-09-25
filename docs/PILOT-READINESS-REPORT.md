# Pilot Readiness Report — Phases 1-8

**Snapshot commit:** `9c1a442` (branch `claude/phase-4-whatsapp-sms-check-2ngbgx`, after merging two
independently-developed lines of work — see §0)
**Date:** 2026-09-25
**Scope:** the phases originally numbered 1-8 (Foundation, Dates/Location, Vehicle, Missing Info,
Channels/CRM, Security, Admin Dashboard, Customer PWA). Phases 9-10/journey Steps 9-19 (Documents
onward) are explicitly out of scope, per request.

This is a point-in-time audit, not a live status feed. `docs/PHASE-CONTRACTS.json` remains the single
source of truth for phase status; if the two ever disagree, trust `PHASE-CONTRACTS.json`. Re-verify
before trusting this document after any further implementation work.

**This replaces an earlier version of this same report written about 30 minutes earlier in this same
session.** That version was wrong: it was written by reading only the commits present at the time,
before discovering that this branch had a second, independently-pushed line of work sitting on
`origin` that had to be merged in first (see §0). It claimed the Admin Dashboard, CRM, Email channel,
and human-escalation did not exist. **They do exist** — this version corrects that, verified against
the actual merged code, not documentation claims.

## 0. Why this report was rewritten — a two-branch merge happened today

While auditing this branch, `git push` was rejected: `origin/claude/phase-4-whatsapp-sms-check-2ngbgx`
had 24 commits that weren't in the local checkout — a second, independently-developed line of work
(Security Engine, journey Steps 5-8, a real Gemini-backed conversational layer, and, on top of those,
a second slice adding the Event/Workflow Engine, CRM, Email, human escalation, and the Admin
Dashboard). Those 24 commits were merged in locally with a plain merge commit — no history rewritten,
nothing force-pushed, nothing discarded. `docs/PHASE-CONTRACTS.json` itself documents this: its
`phaseNumbering` field explains that the project split into two branches after phase 4, each phase
was numbered independently, and on 2026-09-25 both were merged and renumbered into one sequential
15-phase list. **If you know this project by the old 10-phase numbering** (where Security = Phase 6,
Admin Dashboard = Phase 7, Customer PWA = Phase 8), here is the mapping used throughout this report:

| Old id (10-phase scheme) | New id (current `PHASE-CONTRACTS.json`) | Name |
|---|---|---|
| 1-4 | 1-4 (unchanged) | Foundation, Dates/Location, Vehicle, Missing Info |
| 5 | 5 (unchanged) | Channels, Documents, Payments, CRM & Fulfilment |
| — | 6-9 (new) | Eligibility, Availability, Alternatives, Quote (journey Steps 5-8 — did not exist in the old 10-phase scheme at all) |
| 6 | **10** | Security Engine & Zero Trust |
| — | 11 (new) | Conversational AI Engine (Gemini) |
| 7 | **12** | Admin Dashboard (Web) |
| 8 | **13** | Customer Mobile App (PWA) |
| 9 | 14 | Observability, AI Evaluation & Automatic QA |
| 10 | 15 | Infrastructure, CI/CD & Release |

## 1. Executive verdict

This pilot is materially closer to real-life-ready than it looked an hour ago. **All three things
this report was asked to check now exist, with real code and real tests, not just plans:** an Admin
Dashboard staff can actually log into, automatic CRM updates, a working Email channel, and an
automatic human-escalation path. Security (auth, RBAC, tenant isolation) is also fully built and
frozen. What's still missing is concentrated in a smaller, clearer set of gaps than before: Documents,
Payments, delivery/return, invoice, and follow-up (journey Steps 9-19) don't exist yet; the Customer
Mobile App doesn't exist; and — the most important nuance for a real conversation today — **the
automatic WhatsApp/Email pipeline still only runs Steps 1-4 by itself.** Steps 5-8 (Eligibility,
Availability, Alternatives, Quote) are real, tested, and wired into the persisted journey record when
called, but nothing yet calls them automatically after Step 4 finishes — advancing a real booking past
"information collected" requires a person to trigger the next step today (see §5).

## 2. Phase-by-phase status (current `PHASE-CONTRACTS.json` ids)

| id | Phase | Status | What's real |
|----|-------|--------|-------------|
| 1 | Foundation + Enquiry/Intent (Step 1) | **FROZEN** | Unchanged from before — solid. |
| 2 | Dates & Location (Step 2) | **FROZEN** | Unchanged — solid. |
| 3 | Determine Vehicle (Step 3) | **FROZEN** | Unchanged — solid. |
| 4 | Ask Missing Information (Step 4) | **FROZEN** | Unchanged — solid. |
| 5 | Channels/Documents/Payments/CRM/Fulfilment | **IN_PROGRESS** | WhatsApp **and now Email** (Mailgun) channels done; **Event/Workflow Engine done** (persisted `Journey`/`JourneyTransition`); **CRM done** (auto-upserted `Customer`/`CustomerTimelineEvent`); **human escalation done** (`EscalationCase`, Twilio SMS paging, SLA-breach sweep). Web chat, Documents, Payments, delivery/return, invoice PDF, follow-up scheduler still **PENDING**. |
| 6 | Eligibility (journey Step 5) | **FROZEN** | Real, tested, deterministic (zero AI calls). Standalone endpoint — not auto-chained (§5). |
| 7 | Availability (journey Step 6) | **FROZEN** | Real DB-backed inventory + TTL holds, concurrency-tested. Standalone endpoint. |
| 8 | Alternatives (journey Step 7) | **FROZEN** | Real ranking engine against live availability. Standalone endpoint. |
| 9 | Quote / Pricing Engine (journey Step 8) | **FROZEN** | Real pricing, VAT, tamper-evident (HMAC). Standalone endpoint; not linked to the availability hold it prices against. |
| 10 | Security Engine & Zero Trust | **FROZEN** | Real email+password+TOTP MFA, RBAC+ABAC, Postgres RLS, least-privilege DB roles (see §6 caveat). |
| 11 | Conversational AI Engine (Gemini) | **FROZEN** | A real LLM (Gemini) now phrases WhatsApp replies, strictly grounded in Steps 1-4's deterministic output — falls back to the old template on any failure. This is the **first actual generative-AI call anywhere in the system**; everything before it was rule-based. |
| 12 | **Admin Dashboard** | **IN_PROGRESS** | Real login, 5 working screens (Escalation Queue, Journeys, Customers, Fleet, Settings). Home page, live stat tiles, Bookings/Documents/Pricing/Payments/Audit-log screens still **PENDING** (honestly, because their backends don't exist yet either). |
| 13 | Customer Mobile App (PWA) | **PENDING** | Still 0% — no `apps/customer` directory exists. |

## 3. Verified this session (not just read from docs)

- `pnpm install` + `pnpm db:generate` — clean, on the fully merged tree.
- `pnpm typecheck` — **green, 13/13 packages/apps.**
- `pnpm test:unit` — **green, 658/658 tests** (up from 329 before the merge — the new work roughly
  doubled the test count).
- Read `apps/api/src/services/enquiryPipelineService.ts` in full: confirms the automatic pipeline
  (called by both the WhatsApp and Email webhooks) still only runs Steps 1-4.
- Read the relevant half of `apps/api/src/services/journeyService.ts`: confirms
  `syncJourneyAfterMissingInfo` runs automatically right after Step 4 on every channel message, and
  **does** create/advance a persisted `Journey` row and **does** call `decideMissingInfoEscalation`,
  which escalates to a human once a conversation has stayed stuck in `NEEDS_INFO` for too many
  attempts — this is a real, working, automatic escalation trigger, not just an on-demand one.
- Confirmed by direct file listing: `apps/web/src/app/dashboard/**` (13 files: layout, home,
  escalations + actions, journeys list/detail, customers list/detail, fleet, settings, error/loading
  states), `apps/api/src/services/crmService.ts`, `packages/channels/src/email/**` (8 files mirroring
  the WhatsApp adapter), `packages/workflow/**` (state machine + escalation policy),
  `apps/worker/src/jobs/escalationSlaSweep.ts`, `apps/api/src/lib/notificationProvider.ts` (Twilio).
- Confirmed via the Prisma schema: 25 models now exist, including `User`, `RefreshToken`,
  `SecurityEvent`, `EligibilityPolicy/Exception/Decision`, `VehicleUnit`, `AvailabilityHold`,
  `AlternativeRecommendation`, `Quote`, `Journey`/`JourneyTransition`, `EscalationCase`, `Customer`,
  `CustomerTimelineEvent`.
- Confirmed `render.yaml` has been updated with `JWT_SIGNING_SECRET`, `MFA_ENCRYPTION_KEY`,
  `GEMINI_API_KEY`, and `BOOTSTRAP_ADMIN_EMAIL`/`PASSWORD` — but **not** `TWILIO_*` or `MAILGUN_*`.
  On the live Render deployment as currently configured, the Email channel and staff SMS paging would
  both report `NOT_CONFIGURED` until those are added there too (the code correctly degrades rather
  than faking them — this is a deployment-config gap, not a code gap).
- `git branch -a`: still exactly one branch.

## 4. The specific questions asked — corrected answers

### 4.1 Admin Dashboard — **exists, real, working**

`apps/web/src/app/dashboard`: real cookie-based staff login (httpOnly access+refresh tokens, silent
refresh), a shared nav shell, and five working screens wired to real backend data: **Escalation
Queue** (list/filter/assign/resolve against the real `EscalationCase` workflow), **Journeys** (list +
full transition timeline), **Customers** (CRM list + detail + timeline), **Fleet** (read-only
catalog), **Settings** (live per-provider CONFIGURED/NOT_CONFIGURED status). Verified by the phase's
own doc to have been checked by hand in a real browser (login → every screen → a full escalation
assign/resolve cycle → sign-out → auth-gate redirect), not just typechecked. Honestly still missing:
the Home page's live stat tiles (no aggregate-count endpoint exists yet — Home just links to each
section), and screens for Bookings/Documents/Pricing/Payments/Audit log — deliberately not built
because those backends don't exist yet either (building the UI first would be exactly the kind of
fake functionality `CLAUDE.md` forbids).

### 4.2 CRM auto-update — **exists, real, working**

`apps/api/src/services/crmService.ts`: a `Customer` record and `CustomerTimelineEvent` history are
automatically created/updated from journey and webhook activity — no manual step required. Visible
live on the dashboard's Customers screen.

### 4.3 Email auto-resend / Email channel — **exists as a channel; not the exact "resend" behavior**

A full Email channel now exists (`packages/channels/src/email`, Mailgun): real inbound webhook with
signature verification and real outbound sending, mirroring the WhatsApp adapter end to end
(`apps/api/src/routes/webhooks/email.ts`). One clarification: this is a customer-facing reply
channel, not an "automatically resend an email that didn't get answered" feature specifically — no
code was found that resends a previously-sent email. If that specific resend/retry behavior is what
was meant, it doesn't exist yet and would need to be scoped separately.

### 4.4 "AI fails → a human worker is indicated" — **exists and is automatic for Steps 1-4**

Confirmed in code, not just claimed: every WhatsApp/Email message runs `syncJourneyAfterMissingInfo`
after Step 4, which counts repeated `NEEDS_INFO` attempts and automatically escalates
(`decideMissingInfoEscalation` → creates an `EscalationCase` → staff get an SMS page via Twilio, tier-
mapped to an on-call role → the case appears on the dashboard's Escalation Queue) once a customer
conversation is genuinely stuck. Once escalated, the automated pipeline stops sending scripted replies
to that conversation. An SLA-breach sweep (`apps/worker/src/jobs/escalationSlaSweep.ts`) also runs
independently. This is real and tested (24 unit tests across `escalationPolicy`/`stateMachine`, plus
integration tests for the escalation routes).

**Important boundary**: this escalation trigger only fires for the Step 1-4 "stuck collecting info"
case. It does not (and cannot yet) fire for a customer who successfully completes Steps 1-4 but then
needs a human for something in Steps 5-19 (eligibility exceptions, availability conflicts, pricing
review, documents, payment issues) purely automatically — see §5. Eligibility/Quote's own
`decideEligibilityEscalation`/`decideQuoteEscalation` logic exists and is real, but only runs when
their endpoint is actually called, which today means a person (or the dashboard) has to call it.

## 5. The gap that matters most for "is a real booking possible today"

The automatic, no-human-needed pipeline (`runFullEnquiryPipeline`, called by both WhatsApp and Email
webhooks) still only executes Steps 1-4, exactly as before the merge. Steps 5-8 (Eligibility,
Availability, Alternatives, Quote) are real, independently tested, and — when called — correctly
update the same persisted `Journey` record and can themselves trigger escalation. But nothing
automatically calls them once Step 4 reaches `COMPLETE`. Concretely: a customer can message WhatsApp,
get asked for missing details, provide them all, and their journey will sit in `ELIGIBILITY_CHECK`
state indefinitely until a person (via the dashboard, or a direct API call) manually advances it.
This is each phase's own documented, honest limitation (`docs/PHASE-11.md`/`12.md`/`13.md`/`14.md`
§9: "not wired into the WhatsApp auto-pipeline"), not something this audit is guessing at — and it
was still true after re-reading the actual pipeline code today.

## 6. Other real gaps worth knowing about

- **RLS is proven, not yet enforced in the live connection.** `docs/PHASE-6.md` §10 states plainly
  that Postgres Row-Level Security and the least-privilege DB roles are real and tested against a
  scoped connection, but the application's actual default `DATABASE_URL` (local dev, CI, and
  `render.yaml` as it stands) hasn't been switched over to use those scoped roles yet — that cutover
  is deferred to the Infrastructure phase (id 15). Until that switch happens, the deployed app likely
  still connects with broader privileges than RLS is designed to assume.
- **Twilio/Mailgun aren't in `render.yaml` yet** (§3) — Email and SMS paging will report
  `NOT_CONFIGURED` on the live deployment until someone adds those credentials there.
- **Quote and Availability hold are independent** — a quote expiring doesn't release the matching
  hold, and vice versa (`docs/PHASE-14.md` §9).
- **Money in the newer Steps 7-8 work is a JS float in some places** (`docs/PHASE-13.md` §9 flags
  this directly), where `MASTER-PLAN.md` §6 specifies integer minor units everywhere — worth a
  deliberate look before this touches real payments.
- Documents, Payments, delivery/return, invoice PDF, follow-up scheduler (journey Steps 9-19): still
  entirely unbuilt, as expected and out of this report's requested scope.
- Customer Mobile App (PWA, id 13): still 0%.
- Real Docker/CI-scale scanning (Trivy, ZAP): explicitly deferred to the Infrastructure phase, not
  silently skipped.

## 7. What is genuinely solid (credit where due)

Everything in the previous version of this report's §8 still holds, plus: real working staff
authentication (argon2id passwords, TOTP MFA, rotating refresh tokens with reuse detection), Postgres
RLS with a documented STRIDE threat model and a passing kill-chain test, a real LLM in the loop for
the first time (Gemini) with a grounding check that rejects hallucinated prices/availability even from
well-formed model output, and a human-escalation path that was actually exercised end-to-end (login →
escalation → resolve) in a real browser, not just asserted in a test file.

## 8. Open decisions for the user

1. Whether/when to wire Steps 5-8 into the automatic pipeline so a completed enquiry progresses
   without a person triggering each next step (§5) — the single highest-leverage change for making a
   real booking possible without manual intervention.
2. Whether to add the missing Twilio/Mailgun credentials to `render.yaml` so Email and SMS paging
   actually work on the live deployment, not just locally/in tests.
3. Whether the DB-role/RLS cutover (§6) should be pulled forward rather than left until Infrastructure
   (id 15), given it's a live-deployment security gap, not just a future-phase checkbox.
4. What comes next overall: Web chat + Documents + Payments (finishing id 5), the Customer PWA (id
   13), or wiring Steps 5-8 into the pipeline (#1 above).

Do not start building any of the above until the user has explicitly chosen.
