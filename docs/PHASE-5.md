# Phase 5 — WhatsApp Channel Adapter (Meta Cloud API)

Status: **FROZEN**

## 0. Scope note — reconciling this phase's name

`PHASE-CONTRACTS.json`'s original phase-id-5 entry, inherited from the pre-journey-step 10-phase
plan, was named "Channels, Documents, Payments, CRM & Fulfilment" — a much larger grouping than
what this phase actually delivers. Per `docs/PHASE-4.md` §13 (written when Phase 4 froze):

- Phases 1-4 each resolved their `PHASE-CONTRACTS.json` entry to match one real journey step from
  `MASTER-PLAN.md` §4, not the original 10-phase grouping. This phase reconciles id 5 the same way.
- Journey Step 5 in `MASTER-PLAN.md` §4 is **Eligibility** (age/licence/residency/blocklist/deposit
  checks) — a distinct, still-unbuilt piece of work, unrelated to channels. **This phase is not
  Step 5 and does not implement Eligibility.**
- What this phase actually builds is the WhatsApp slice of the original phase-5 grouping, explicitly
  requested ahead of Eligibility. The remaining original phase-5 scope — documents, payments, CRM,
  fulfilment, and the Web-chat/Email channel adapters — is **not built** and doesn't have a
  `PHASE-CONTRACTS.json` id yet; it needs its own future phase(s) when picked up, same as journey
  Step 5 does.

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`, `docs/MASTER-PLAN.md` (no
  UI changes this phase, so `docs/DESIGN-SYSTEM.md` has nothing to apply).
- Read `docs/PHASE-4.md` (previous phase) and its §13 forward contract, which surfaced the scope
  note above.
- Inspected the repository: `apps/api`'s Steps 1-4 routes/services, `packages/security`'s
  `webhookSignature.ts` / `ssrfSafeFetch.ts` / `resilience.ts`, the `Conversation`/`Message`/
  `IdempotencyKey` Prisma models, `apps/api/src/test/buildTestApp.ts`, and existing integration/
  security test conventions — all already had exactly the seams this phase needed (see §3).
- Installed PostgreSQL 16 and started Redis locally in this sandbox (no Docker daemon here, same
  documented limitation as Phases 1-4) and ran the existing suite as a baseline before changing
  anything: 64 integration tests and 37 security tests, both matching `docs/PHASE-4.md` §8 exactly.

## 2. Scope

Goal: let a real WhatsApp message reach the existing, already-frozen Steps 1-4 pipeline and get an
automatic reply — including the Step 4 clarification question when something is missing — without
changing any of that pipeline's business logic.

Out of scope (deferred, not silently skipped):

- Journey Step 5 (Eligibility) — see §0.
- The rest of the original phase-5 grouping: document pipeline, `PaymentProvider`, CRM adapter,
  delivery/return coordination, invoice PDFs, Web-chat/Email channel adapters.
- A real conversational loop / thread memory across messages (see §3's "each message is
  independent" decision) — that's the Event/Workflow Engine, per `PHASE-4.md` §13.
- Admin-visible provider status (`docs/MASTER-PLAN.md` Phase 7's Settings screen) — `whatsappStatus`
  is on `AppContext` and logged at startup, but there's no admin UI yet to show it in.

## 3. Design decisions

- **A channel adapter, not new business logic.** `handleInboundWhatsAppMessage`
  (`apps/api/src/services/whatsappService.ts`) calls the exact same four service functions a REST
  client already drives — `submitEnquiry` → `extractDatesAndLocation` → `determineVehicle` →
  `checkMissingInfo` — in the same sequence, then maps the Step 4 result to reply text. No new
  domain rules were written; every field-resolution/validation decision still comes from Phases 1-4.
- **Every inbound message starts a fresh conversation** — matching `submitEnquiry`'s own contract
  exactly (channel `WHATSAPP`, `customerRef` = the sender's WhatsApp id). There is deliberately no
  "find the customer's open conversation and append to it" logic: Steps 2-3 already only ever read
  a conversation's _latest_ message, so threading messages together wouldn't accumulate context
  without also building real cross-message field carry-forward — exactly the conversational loop
  `PHASE-4.md` §13 scoped to the Event/Workflow Engine, not a channel adapter. A customer's reply to
  a clarification question is processed as its own independent enquiry today; documented below as a
  known limitation rather than half-built.
- **Duplicate delivery protection reuses the existing `IdempotencyKey` table as-is** — Meta's
  message id (`wamid...`) is passed as `submitEnquiry`'s existing `idempotencyKey` parameter, and
  `whatsappService` also checks it directly before doing anything, so a redelivered webhook short-
  circuits before creating a second conversation or sending a second reply. No new table, no new
  repository function.
- **Signature verification wraps the existing generic primitive**, exactly as
  `webhookSignature.ts`'s own Phase 1 doc comment anticipated ("Channel adapters … wrap this with
  their provider's specific header name and encoding in later phases"): `whatsappSignature.ts`
  strips Meta's `sha256=` prefix and calls `verifyWebhookSignature` unchanged.
- **A dedicated `WHATSAPP_APP_SECRET`, distinct from the existing `WEBHOOK_SIGNING_SECRET`.** The
  latter is a `generateValue: true` random secret Render mints itself (`.env.example`: "placeholder
  only — replace per channel in later phases") — it can never equal Meta's own App Secret, which
  Meta issues and which we must copy in verbatim. Reusing it would silently never verify in
  production, so this phase leaves it untouched and adds four new, independent, all-optional env
  vars instead (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`,
  `WHATSAPP_APP_SECRET`).
- **Raw body capture is scoped to just this route**, not a global Fastify option change. Meta signs
  the exact raw bytes, but Fastify's default JSON parser discards them. `whatsappWebhookRoutes`
  registers its own `addContentTypeParser('application/json', { parseAs: 'buffer' }, …)` — Fastify
  content-type parsers are per-plugin-context, so every other route (enquiries, temporal, vehicle,
  missing-info, health) keeps the app's normal parsed-JSON body untouched (proven in
  `whatsapp.integration.test.ts`'s "does not break the existing REST enquiries endpoint" case).
- **The outbound Graph API call reuses `ssrfSafeFetch`** with a one-item allowlist
  (`graph.facebook.com`), even though that helper's own doc comment frames it for
  configuration-driven targets rather than a hardcoded one — it's still a strict superset of
  protection (timeout, redirect-refusal, DNS-rebind check) for free, and avoids a second bespoke
  fetch-with-timeout implementation.
- **The webhook is exempt from the app-wide per-IP rate limiter** (`config: { rateLimit: false }`
  on both routes). Meta calls webhooks from a shared IP pool serving every customer's messages, not
  one IP per customer; the existing limiter is shaped for browser/API clients and would throttle the
  whole business's WhatsApp traffic through one counter. The endpoint is still protected by
  signature verification (POST) and the verify-token check (GET).
- **`WhatsAppClient` is a provider seam with a `NotConfiguredWhatsAppClient`**, mirroring the
  `AIProvider`/`LocationProvider`/`VehicleCatalogProvider` pattern already used everywhere else:
  `createWhatsAppClient(config)` (shared by `server.ts` and `buildTestApp.ts`, so both construct it
  identically) requires all four env vars together — a partially-configured adapter is
  `NOT_CONFIGURED` rather than guessing which half to trust — and returns `{ client, status }`,
  surfaced on `AppContext` and logged once at API startup.
- **No new package.** `MASTER-PLAN.md` §2's target layout has a `packages/channels` package for
  channel adapters; this phase keeps everything in `apps/api` (`lib/whatsapp*.ts`,
  `services/whatsapp*.ts`, `routes/webhooks/whatsapp.ts`) since there's only one adapter so far —
  extracting a shared package ahead of a second channel needing the same shape would be premature
  generalization.

## 4. What was built

- `apps/api/src/env.ts` — four new optional env vars: `WHATSAPP_ACCESS_TOKEN`,
  `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`.
- `apps/api/src/lib/whatsappSignature.ts` — `verifyMetaWebhookSignature` (Meta's `sha256=` header
  encoding over the generic HMAC verifier).
- `apps/api/src/lib/whatsappWebhookPayload.ts` — `whatsappWebhookPayloadSchema` (Zod, tolerant of
  fields this adapter doesn't read) and `extractInboundMessages`, flattening
  `entry[].changes[].value.messages[]` and leaving `statuses[]` (delivery receipts) untouched.
- `apps/api/src/lib/whatsappClient.ts` — `WhatsAppClient` interface,
  `NotConfiguredWhatsAppClient`, `MetaCloudApiWhatsAppClient` (Graph API `v21.0` send via
  `ssrfSafeFetch`), `createWhatsAppClient` factory.
- `apps/api/src/services/whatsappReply.ts` — `buildWhatsAppReplyText`, mapping each
  `MissingInfoResult.status` to customer-facing copy (the `NEEDS_INFO` case returns Step 4's own
  `clarificationPrompt` verbatim — no new copy invented there).
- `apps/api/src/services/whatsappService.ts` — `handleInboundWhatsAppMessage`: idempotency
  short-circuit, unsupported-message-type and too-long-message fallbacks, the Steps 1-4 pipeline
  call sequence, and a caught-and-logged fallback reply if any step throws.
- `apps/api/src/routes/webhooks/whatsapp.ts` — `GET /webhooks/whatsapp` (challenge verification)
  and `POST /webhooks/whatsapp` (signature verify → parse → dedupe → pipeline → reply), registered
  as its own encapsulated Fastify plugin.
- `apps/api/src/context.ts`, `server.ts`, `test/buildTestApp.ts`, `app.ts` — `whatsappClient` /
  `whatsappStatus` wired into `AppContext`; route registered.
- `render.yaml`, `.env.example` — the four new env vars documented (Render: `sync: false`, no
  `generateValue`, since these come from Meta, not from Render).
- No Prisma migration — `Channel.WHATSAPP`, `Conversation`, `Message`, and `IdempotencyKey` already
  existed from Phase 1.

## 5. APIs

| Method | Path                 | Purpose                                                              |
| ------ | -------------------- | -------------------------------------------------------------------- |
| GET    | `/webhooks/whatsapp` | Meta's webhook subscription challenge/verification                   |
| POST   | `/webhooks/whatsapp` | Inbound WhatsApp messages; triggers Steps 1-4 and an automatic reply |

Neither is part of the versioned `/v1` REST surface or the OpenAPI doc — they're an external
provider's contract (Meta's), not ours, matching `MASTER-PLAN.md` §1's "Customer channels … `apps/api`
(webhooks)" as a distinct concern from the `/v1` resources.

## 6. Database schema

No migration. `Conversation.channel = WHATSAPP` (existing enum value), `Conversation.customerRef` =
the sender's WhatsApp id, and the existing `IdempotencyKey` table (keyed by Meta's message id
instead of a client-supplied header) are all reused unchanged.

## 7. Security decisions

**Implemented and tested (real end-to-end, see §8 — not written-but-unrun):**

- **Signature verification is mandatory** — every `POST` without a valid `X-Hub-Signature-256` (
  missing, wrong secret, or a tampered body after signing) is rejected `401` before the body is even
  parsed as JSON, and does not create a conversation.
- **Never trusts the payload shape** — `whatsappWebhookPayloadSchema.safeParse` rejects malformed
  JSON and wrong-shaped-but-valid JSON alike with `400`, before any pipeline code runs.
- **Never trusts the message content** — the extracted text still goes through
  `messageContentSchema` (the same boundary every other channel uses) before reaching
  `submitEnquiry`; prompt-injection and SQL-injection payloads in a WhatsApp message are handled
  exactly as inertly as the existing REST path already proved (Phases 1-2's own sanitizer/Prisma
  parameterization — nothing new was added or needed here).
- **No secrets or stack traces in any error response** — proven the same way `missingInfo.security.
test.ts` already proves it for the REST endpoints.
- **NOT_CONFIGURED is explicit** — a `POST` with `WHATSAPP_APP_SECRET` unset returns `501` with that
  code, never a silent 200 or a crash; the same is true for outbound sends via
  `NotConfiguredWhatsAppClient`.
- **Rate-limit exemption is a deliberate, documented tradeoff**, not an oversight — see §3.

**Explicitly deferred (documented, not silently skipped):**

- Database-level Row Level Security — unchanged from Phases 1-4, still Phase 6 scope.
- The pre-existing idempotency race noted in `enquiryService.ts` (two _genuinely concurrent_
  deliveries of the same message id could both pass the pre-check before either's write commits) —
  inherited from Phase 1's `submitEnquiry`, not introduced here, and no more likely for WhatsApp
  redeliveries (minutes apart, not concurrent) than it already was for REST clients.
- A large multi-message batch in one webhook call is processed synchronously in the request handler
  (sequentially, each through the full pipeline) — fine at the volumes this business will see
  starting out, but a slow batch could risk Meta's own webhook-response timeout; moving inbound
  processing onto the BullMQ worker instead of the request handler would remove that ceiling
  entirely and is a reasonable follow-up once volume justifies it.

## 8. Test results

All commands run against real local PostgreSQL 16 + Redis 7 (installed and started in this sandbox;
Docker daemon still unavailable here, same as every prior phase) — genuine HTTP requests through the
real Fastify app (`app.inject`), real HMAC signatures, real database writes, not mocks standing in
for the boundary being tested.

| Gate        | Command                 | Result                                                                      |
| ----------- | ----------------------- | --------------------------------------------------------------------------- |
| Typecheck   | `pnpm typecheck`        | ✅ 11/11 packages                                                           |
| Lint        | `pnpm lint`             | ✅ 0 errors, 0 warnings                                                     |
| Format      | `pnpm format:check`     | ✅ clean                                                                    |
| Unit        | `pnpm test:unit`        | ✅ 340 tests (31 new: signature 6, payload 9, client 6, reply 5, service 5) |
| Integration | `pnpm test:integration` | ✅ 69 tests (5 new — real webhook → real conversation → real reply capture) |
| Security    | `pnpm test:security`    | ✅ 48 tests (11 new — signature/shape/NOT_CONFIGURED/injection)             |
| E2E         | `pnpm test:e2e`         | ✅ 4 tests, unchanged (no UI touched)                                       |
| Build       | `pnpm build`            | ✅ every package + Next.js production build                                 |

Full Phase 1-4 regression re-run and green: every pre-existing test (302 unit baseline +
`redisHealth`'s 4 from the prior session, 64 integration, 37 security, 4 e2e) still passes
unchanged, plus this phase's new coverage — nothing existing was broken.

Key scenarios proven end-to-end in `apps/api/src/whatsapp.integration.test.ts` /
`whatsapp.security.test.ts`:

| Case                                                              | Result                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET challenge with the correct verify token                       | raw challenge echoed, `200`                                                                     |
| GET with wrong token / wrong mode                                 | `403`, no leak of the expected token                                                            |
| POST with no / wrong / tampered signature                         | `401`, no conversation created                                                                  |
| POST with `WHATSAPP_APP_SECRET` unset                             | `501 NOT_CONFIGURED`                                                                            |
| POST with malformed JSON (valid signature over those exact bytes) | `400`                                                                                           |
| POST with valid JSON, wrong shape                                 | `400`                                                                                           |
| A real text message                                               | conversation + message created, Steps 2-4 all run, `missingInfoCheck` persisted, reply captured |
| The same message id redelivered                                   | processed once — one conversation, one reply                                                    |
| Prompt injection / SQL injection in the message body              | inert text, `200`, flagged the same as the REST path                                            |
| Existing `POST /v1/enquiries`                                     | still `201` — unaffected by the new route                                                       |

## 9. Known limitations

- **No conversational thread memory** — see §3; a customer's follow-up reply is a new, independent
  enquiry, not merged with what an earlier message in the same phone-number "conversation" resolved.
- **English-only reply copy** — same class of limitation as Phases 1-4's lexicons and Step 4's
  clarification prompts.
- **No admin-visible provider status yet** — `whatsappStatus` exists on `AppContext` and is logged
  at startup; there's no Settings screen to show it in until Phase 7.
- **Synchronous per-webhook processing** — see §7's deferred item on batch size / worker offload.
- **No Docker daemon in this dev sandbox** (same as every prior phase) — `docker-compose.yml`
  unaffected and correct for normal local/CI use; PostgreSQL 16 and Redis were installed and run
  directly here instead, matching Phases 1-4's own precedent.
- **Journey Step 5 (Eligibility) remains unbuilt** — see §0; this phase does not touch it.

## 10. Files created

- `apps/api/src/lib/whatsappSignature.ts` (+ `.test.ts`)
- `apps/api/src/lib/whatsappWebhookPayload.ts` (+ `.test.ts`)
- `apps/api/src/lib/whatsappClient.ts` (+ `.test.ts`)
- `apps/api/src/services/whatsappReply.ts` (+ `.test.ts`)
- `apps/api/src/services/whatsappService.ts` (+ `.test.ts`)
- `apps/api/src/routes/webhooks/whatsapp.ts`
- `apps/api/src/whatsapp.integration.test.ts`, `apps/api/src/whatsapp.security.test.ts`
- `docs/PHASE-5.md` (this file)

## 11. Files modified

- `apps/api/src/env.ts` — four new optional env vars.
- `apps/api/src/context.ts`, `server.ts`, `app.ts`, `test/buildTestApp.ts` — `whatsappClient` /
  `whatsappStatus` wired in; route registered.
- `render.yaml`, `.env.example` — new env vars documented.
- `.gitignore` — `dump.rdb` (a local Redis persistence artifact from testing this phase in a
  sandbox without Docker, not project output).
- `docs/PHASE-CONTRACTS.json` — id 5 renamed/reconciled to this phase's actual scope, marked
  `FROZEN`, `phaseDoc` updated to `docs/PHASE-5.md` (matching how Phases 2-4 each already broke from
  the original `docs/phases/PHASE-0N.md` placeholder path once reconciled).

No working Phase 1-4 functionality was changed; the full existing test suite re-run and green (§8)
is the proof.

## 12. Migration status

None. No schema change was needed for this phase.

## 13. Next-phase contract (proposed inputs)

Two independent, still-open pieces of work, either of which could come next:

- **Journey Step 5 — Eligibility** (`MASTER-PLAN.md` §4): tenant rules (min age per class, licence
  type, residency, blocklist, deposit ability). Reads whatever Steps 1-4 already resolved, same
  "AI proposes / deterministic domain logic verifies" split — though, like Step 4, it may need no new
  AI-proposes step at all, since tenant rules are deterministic by nature.
- **The remaining original phase-5 scope**: document pipeline, `PaymentProvider`, CRM adapter,
  delivery/return coordination, invoice PDFs, and the Web-chat/Email channel adapters (this phase's
  `WhatsAppClient` seam and `lib/whatsappWebhookPayload.ts`'s parsing pattern are a template for the
  latter two).

Do not start either until asked.
