# Phase 12 — Admin Dashboard (Web)

> Filename is historical (`PHASE-07.md`, pointed to by `PHASE-CONTRACTS.json`'s `phaseDoc` field for
> id 12) — see that file's top-level note on why phase-doc filenames and current phase ids can differ.
> Status: **IN_PROGRESS**, not FROZEN — see §2 for what is deliberately out of scope right now.

## 1. Pre-flight (Protocol §Before changing code)

- [x] Read `docs/PHASE-CONTRACTS.json` — id 12 (Admin Dashboard) was `PENDING`, promoted to `IN_PROGRESS` by this work
- [x] Read `docs/phases/PHASE-06.md` (the most recent prior phase doc)
- [x] Inspected repository: `apps/web` had only a Phase-1 enquiry form; no auth, no admin routes, no dashboard screens
- [x] Ran baseline test suite before starting — full repo green (typecheck, lint, unit, integration, security)
- [x] Reviewed `MASTER-PLAN.md` §1 (Event/Workflow Engine, Admin Dashboard box) and `DESIGN-SYSTEM.md` (Emerald & Copper tokens, component vocabulary, Admin Dashboard Home screen contract)

## 2. Scope

Goal (from contract): dashboard wireframe, pixel-faithful to the design system.

This increment was explicitly requested and scoped by the user to **Steps 1-8 only** — the parts of
the system with real, tested backend functionality (Enquiry through Quote, plus the Event/Workflow
Engine, human escalation, and CRM auto-sync layered on top of them earlier this session). Building
dashboard screens for functionality that doesn't exist yet (Bookings, Documents, Payments, Invoices)
would be exactly the "fake functionality to pass a screen" CLAUDE.md forbids, so those were left out
rather than stubbed.

Deliverables built this increment:

- [x] Backend prerequisites: `GET /v1/journeys`, `/v1/vehicles`, `/v1/customers`, `/v1/customers/:id`,
      `/v1/settings/providers` (all gated on `journey:read`/`customer:read`, already held by every
      staff role)
- [x] Cookie-based staff auth for the web app: httpOnly access+refresh token cookies
      (`apps/web/src/lib/session.ts`), a silent background refresh loop
      (`SessionKeepAlive`, refreshes every 10 min against the 15-min access-token TTL) so an active
      session survives a shift, and `packages/db/src/bootstrapAdmin.ts` (idempotent, env-driven) to
      create the very first account — without it a fresh deploy would have a fleet and a tenant but
      no way to sign into the dashboard at all
- [x] Shared dashboard shell: `TopBar` (signed-in user, sign-out), `DashboardNav` (active-state
      links), auth gate in the `(dashboard)` layout (Server Component, redirects to `/login` on no/
      expired session)
- [x] Login screen (email/password, MFA-code step when the account has MFA enabled)
- [x] **Escalation Queue** (the user's explicit priority — "the screen where the human worker
      actually acts"): list with status filter tabs, tier/status/SLA-breach chips, Assign-to-me and
      Approve/Reject-with-note actions, wired to the real `EscalationCase` workflow
      (`apps/api/src/services/escalationService.ts`) — a worker acting here is the human half of
      "AI escalates to a human" the user asked for
- [x] **Journeys**: list (most-recently-updated first) + detail (context fields, full
      `JourneyTransition` timeline with actor/reason/timestamp)
- [x] **Customers** (CRM): list + detail with the automatic CRM timeline
- [x] **Fleet**: read-only catalog (category, tier, seats/luggage/transmission, live pricing)
- [x] **Settings**: live per-provider status (WhatsApp / Email / SMS / Conversational AI /
      Observability), each genuinely `CONFIGURED`/`NOT_CONFIGURED` — proven by a dedicated
      integration test asserting it never reports a fake `CONFIGURED`
- [x] Home: a simple, honest set of links into each section (no fabricated KPI numbers — see below)

Out of scope for this increment (all genuinely `PENDING` elsewhere in the contract, not skipped
carelessly):

- Bookings, Document review, Pricing, Payments/Invoices, Audit log screens — no real backend for any
  of these yet (id 5's Documents/Payments/delivery-return remain `PENDING`)
- Home's live `JourneyStepper`/`StatTiles` — would need a new aggregate-count endpoint; showing
  hardcoded or client-computed placeholder numbers would be a fake KPI, so Home links to each section
  instead
- Real-time updates via SSE
- Per-role navigation hiding — every staff role (`ADMIN`/`MANAGER`/`OPS_AGENT`/`SECURITY`) already
  holds the same journey/escalation/customer read+act permissions (`packages/domain/src/auth.ts`'s
  own documented reasoning: tier is a routing/paging concern, not a visibility wall), so there is no
  per-role nav difference to build yet
- Playwright e2e + visual regression against `docs/design/reference` — the flow was verified by hand
  against a real Postgres/Redis dev stack and a real Chromium browser (see §6) but no test file was
  checked in this increment

## 3. Design / decisions

- No ADRs added — this is UI/wiring work on top of already-decided architecture, not a new
  architectural decision.
- **Server Components for reads, Server Actions for writes.** Every list/detail screen is a Server
  Component that reads the session cookie and calls the API directly server-side
  (`apps/web/src/lib/adminApi.ts`); escalation assign/resolve are Server Actions
  (`apps/web/src/app/dashboard/escalations/actions.ts`) bound to plain `<form>` elements. This
  avoids hand-rolling a parallel `/api/admin/*` proxy-route layer for every screen (the natural
  alternative, given the existing `/api/enquiries` route's fetch-from-client-component convention)
  while keeping every outbound call funneled through the same `ssrfSafeFetch` allowlist discipline
  as the rest of the app (`apps/web/src/lib/backendFetch.ts`).
- **Cookie-based BFF auth, not a client-visible token.** The access/refresh token pair never reaches
  browser JS — only httpOnly cookies set by `POST /api/session/login`. A proactive background
  refresh (not a reactive refresh-on-401) was chosen because Server Components cannot write cookies
  mid-render in Next.js; a refresh-on-401 retry would need to happen somewhere that _can_ write
  cookies (middleware or a route handler), which adds real complexity for a 15-minute token TTL that
  a 10-minute keep-alive already comfortably covers.
- **First-admin bootstrap, not a self-serve signup route.** `POST /v1/users` (human provisioning)
  doesn't exist yet by design (`Permission.USER_*` is a Security-tier concern, not part of this
  phase). Without _some_ way to create the first account, a fresh deploy's dashboard would be
  permanently locked out — `packages/db/src/bootstrapAdmin.ts` is the minimal, idempotent fix,
  wired into both `scripts/start-production.mjs` and `render.yaml`'s `startCommand`, gated on two
  new optional env vars that are a no-op when unset.
- **`encodeURIComponent` on every path-interpolated ID in `adminApi.ts`.** Route params
  (`conversationId`, `customerId`, `escalationCaseId`) originate from Next.js dynamic segments;
  interpolating them unescaped into the backend fetch URL would let a crafted segment (e.g. containing
  `/`) redirect the request to an unintended backend path. The backend's own Zod `.uuid()` validation
  would reject it either way, but escaping at the source is the correct fix, not a redundant one.
- Backward-compatibility: fully additive — no existing route, schema, or UI changed behavior; the
  only touch to a previously-untested seam was adding a `whatsappProviderStatus` field alongside the
  three provider-status fields that already existed (an inconsistency found while wiring Settings).

## 4. Implementation notes

- New/changed packages: `apps/web` gained `@ai-concierge/domain` as a direct dependency (for
  `JourneyState`/`EscalationStatus`/`EscalationReason`/`Permission` enum values used in UI logic,
  rather than hardcoding string literals); `packages/db` gained `@ai-concierge/security` as a real
  (not dev) dependency, needed by `bootstrapAdmin.ts` at runtime.
- New endpoints: `GET /v1/journeys`, `/v1/vehicles`, `/v1/customers`, `/v1/customers/:customerId`,
  `/v1/settings/providers` (`apps/api/src/routes/v1/admin.ts`); no new migrations.
- New script: `pnpm --filter @ai-concierge/db run bootstrap-admin`
  (`packages/db/src/bootstrapAdmin.ts`).
- Boundaries validated with Zod: every new API response is parsed against its contract schema before
  the page trusts it (`adminApi.ts`'s `adminGet`/`adminPost`); the login route validates the request
  body against `loginRequestSchema` before forwarding upstream; the resolve Server Action validates
  `FormData` against the real `resolveEscalationBodySchema` before calling the API.
- Idempotency / transactions / audit: unchanged from the existing journey/escalation services this
  phase reads and calls — no new mutation logic was added server-side, only new read endpoints and a
  UI layer on top of the already-transactional/audited `escalationService.ts`.
- Providers behind interfaces + `NOT_CONFIGURED` states: the Settings screen is the first UI
  consumer of the existing per-provider status fields; it adds no new provider, just displays the
  real ones honestly (see the dedicated regression test asserting this).

## 5. Gate results (Protocol §Quality gate pipeline)

| Gate                | Command                 | Result     | Notes                                                                  |
| ------------------- | ----------------------- | ---------- | ---------------------------------------------------------------------- |
| Typecheck           | `pnpm typecheck`        | ✅ green   | all 13 workspace packages                                              |
| Lint                | `pnpm lint`             | ✅ green   | `eslint . --max-warnings=0`                                            |
| Unit                | `pnpm test:unit`        | ✅ green   | 503 tests across all packages (incl. new `formatEnumLabel` tests)      |
| Integration         | `pnpm test:integration` | ✅ green   | 315 tests, incl. the 5-test `adminRoutes.integration.test.ts`          |
| Security            | `pnpm test:security`    | ✅ green   | 137 tests                                                              |
| E2E                 | `pnpm test:e2e`         | ⬜ not run | no Playwright spec file added this increment (see §2 out-of-scope)     |
| Build               | `pnpm build`            | ✅ green   | production build succeeds for every package, incl. `next build`        |
| Code review         | manual self-review      | ✅ done    | see §3/§6; `encodeURIComponent` hardening applied during review        |
| Architecture review | checklist §1/§6         | ✅ done    | Server Component reads / Server Action writes, cookie-BFF pattern      |
| Regression          | full repo test suite    | ✅ green   | run after every increment (admin routes, then dashboard shell+screens) |

Migrations: none added this increment — N/A.

## 6. Acceptance criteria — demonstrated

- Screens match `DESIGN-SYSTEM.md` contracts for the 5 screens built — demonstrated by hand against a
  real dev stack (local Postgres/Redis, real seeded fleet, a real bootstrapped admin account, and a
  real escalation case created through the actual `journeyService`/`escalationService` code paths, not
  fixtures):
  - Login → dashboard → every nav screen → sign-out → visiting `/dashboard` while signed out redirects
    to `/login` (auth gate proven both ways)
  - Full Escalation Queue cycle: OPEN case visible → "Assign to me" → status flips to `IN_PROGRESS`
    with the resolve form → Approve + note → status flips to `RESOLVED`, resolution/note displayed —
    each transition confirmed against the database directly, not just the screenshot
  - Journeys list → detail: real `JourneyTransition` history (4 hops from a real
    `syncJourneyAfterMissingInfo` call) rendered correctly with actor chips and reasons
  - Fleet: real seeded catalog (Lamborghini Urus, Range Rover) with correct pricing/specs
  - Settings: all 5 providers correctly reported `NOT_CONFIGURED` against a dev `.env` with none of
    them set — proves the screen reads live status, not a hardcoded value
- Visual regression against `docs/design/reference`: not run — no Playwright visual-regression suite
  exists yet for this phase (see §2).
- Role-aware nav: N/A this increment — see §2/§3.

## 7. Security checklist (this phase)

- [x] No untrusted input reaches a sink without Zod validation — every API response parsed against
      its contract schema; every mutating Server Action validates `FormData` against the real
      contract schema before calling the API; the login route validates its body before forwarding
- [x] No AI/customer/external/document input trusted implicitly — this phase adds no new AI/customer
      input surface, only staff-facing reads/actions behind `authenticate`
- [x] Least-privilege respected — every new route gated on `authenticate` + the existing
      `journey:read`/`customer:read` permissions; access/refresh tokens are httpOnly (never reachable
      from browser JS); `sameSite: 'lax'` cookies are this app's CSRF defense for the mutating Server
      Actions (a cross-site POST never carries a Lax cookie)
- [x] Secrets not committed — `.env` stays gitignored; `BOOTSTRAP_ADMIN_EMAIL`/`_PASSWORD` documented
      in `.env.example`/`render.yaml` as `sync: false` (set in the provider dashboard, never in git)
- [x] New surfaces covered by authz tests — `adminRoutes.integration.test.ts` asserts every admin
      list route rejects unauthenticated requests

## 8. Docs updated

- [x] `docs/phases/PHASE-07.md` (this file)
- [ ] `docs/ARCHITECTURE.md` — not updated; no architectural change, only an additive UI/BFF layer
      following already-documented patterns
- [x] `docs/PHASE-CONTRACTS.json` → id 12 set to `IN_PROGRESS` (not `FROZEN` — see §2); id 5's
      `progressNote`/`deliverables` also corrected to reflect Email channel + CRM adapter work that
      had already landed earlier this session but was never reflected there

## 9. Sign-off

- No fake functionality introduced — Settings reports real provider status; no screen was built for
  backend functionality that doesn't exist (Bookings/Documents/Payments/Invoices); Home shows real
  links, not fabricated KPI numbers.
- No working functionality deleted; no existing route, schema, or screen's behavior changed.
- Ready for next phase: ☐ — intentionally not checked. This phase stays `IN_PROGRESS`: the
  Bookings/Documents/Payments/Invoices/Audit-log screens, live Home KPIs, SSE, and e2e/visual-
  regression coverage are real, tracked remaining work, to resume once their backend phases
  (primarily id 5) are built out.
