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
- **A message continues the customer's open conversation, updated 2026-09-21 (see §14).** The
  original Phase 5 freeze shipped "every inbound message starts a fresh conversation" here, with no
  cross-message memory — see §14 for why that turned out to be the actual bug behind a live report
  ("only one generic WhatsApp reply, no real conversation") and what replaced it.
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

- **Conversation continuation has a narrow concurrent-delivery race** — see §14; two genuinely
  simultaneous messages from the same customer could each start their own conversation instead of
  merging into one, the same accepted-and-documented class of race as the pre-existing idempotency
  pre-check (§7), and no more likely in practice.
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

## 14. Amendment (2026-09-21) — conversation continuity

A live WhatsApp number showed exactly one generic reply repeated over and over ("Thanks for
reaching out — let us know if you'd like to book a car…") no matter what the customer sent next —
never a real, progressing conversation. Root cause was precisely this phase's own §3/§9 "every
inbound message starts a fresh conversation" decision, made deliberately at the time but with a
sharper consequence than documented: a follow-up message that's just dates, or just a location
(e.g. "25 sept to 29 sept"), carries no booking keyword on its own
(`packages/ai/src/lexicon.ts`'s `INTENT_KEYWORDS`), so Step 1 classified it `UNKNOWN` in isolation,
Step 4 returned `NOT_APPLICABLE` (`RequiredFieldsEvaluator` gates entirely on
`intent.intentType === 'BOOKING_REQUEST'`), and the customer got the generic non-booking fallback —
every single turn, regardless of what an earlier message in the same conversation had already
established.

Fixed without touching Steps 1-4's own engines (`RuleBasedIntentEngine`, `DateExtractionService`,
`LocationExtractionService`, `VehicleIntentService`, `TemporalValidationService`,
`VehicleValidationService`, `RequiredFieldsEvaluator` — all unchanged, all still frozen/tested as
shipped) — only what conversation a message belongs to, and what text Steps 1-3 extract from:

- **A message continues the customer's open conversation** instead of always starting a fresh one.
  `findOpenConversationForCustomer` (`packages/db/src/repositories/conversationRepository.ts`) finds
  the customer's most recent conversation on this channel unless it already reached a terminal Step 4
  outcome (`COMPLETE`/`EXPIRED`), derived from the latest message's latest `MissingInfoCheck` — no
  new column, same append-only-history convention every other cross-step read here already uses.
- **`continueEnquiry`** (`apps/api/src/services/enquiryService.ts`), a sibling to `submitEnquiry` for
  a conversation that already exists: appends the message (`appendMessageToConversation`), then runs
  Step 1 intent recognition against the conversation's accumulated transcript rather than this
  message alone. No `postEnquiryQueue` job — that background processing already ran for this
  conversation's first message.
- **`buildAccumulatedTranscript`** (`apps/api/src/lib/conversationTranscript.ts`) joins a
  conversation's messages oldest-first (bounded to the most recent 25 messages / 8000 characters, so
  a customer sending many messages can't grow the extraction input unboundedly). `dateLocationService.ts`
  and `vehicleService.ts` now extract from this joined transcript instead of only the latest message —
  for a single-message conversation (every existing REST `/v1/enquiries` caller, today) this is
  byte-for-byte identical to before, so nothing about the REST contract or Steps 2-3's own tested
  behavior changed; only WhatsApp's multi-turn case is different.
- **Accepted, documented limitation**: `findOpenConversationForCustomer` is read outside any
  transaction, so two genuinely concurrent deliveries from the same customer could each see "nothing
  open" and start their own conversation — the same class of race §7 already accepts for the
  idempotency-key pre-check, and no more likely here (real replies from one person are
  seconds-to-minutes apart, not concurrent).
- **Not changed**: REST `/v1/enquiries` still always creates a fresh conversation per call (no
  "continue" REST endpoint exists); this amendment is scoped to the WhatsApp channel adapter, same
  boundary as the rest of this phase.

Proof (`apps/api/src/whatsapp.integration.test.ts`): a real two-turn conversation through the actual
webhook (real HMAC signature, real DB) — turn 1 "I want to rent a Lamborghini Urus" alone (no
dates/location), turn 2 "from 15 Oct to 19 Oct, pickup at Dubai Marina" alone (no booking/vehicle
keyword) — lands in one conversation with two messages, and turn 2's reply is neither a repeat of
turn 1's question nor the generic non-booking fallback; a same-customer flood of 30 messages stays
bounded and healthy (`whatsapp.security.test.ts`); a prompt-injection payload in a later turn is
still flagged; a conversation that already completed starts a new one for the next message from the
same customer, and two different customers are never merged into one thread.

Full Phase 1-5 regression re-run and green, cumulative: typecheck, lint, format all clean; **353
unit** (340 + 13: `conversationTranscript.test.ts` 5, `enquiryService.test.ts` +4, `whatsappService.test.ts`
+2, `dateLocationService.test.ts` +1, `vehicleService.test.ts` +1); **85 integration** (69 + 16:
`conversationRepository.test.ts` +13, `whatsapp.integration.test.ts` +3); **50 security** (48 + 2:
`whatsapp.security.test.ts` +2); **4 e2e** unchanged; production build green. No working Phase 1-5
functionality changed — every pre-existing test still passes unmodified.

Files added: `apps/api/src/lib/conversationTranscript.ts` (+ `.test.ts`).
Files modified: `packages/db/src/repositories/conversationRepository.ts` (+ `.test.ts`),
`apps/api/src/services/enquiryService.ts` (+ `.test.ts`), `apps/api/src/services/dateLocationService.ts`
(+ `.test.ts`), `apps/api/src/services/vehicleService.ts` (+ `.test.ts`),
`apps/api/src/services/whatsappService.ts` (+ `.test.ts`), `apps/api/src/whatsapp.integration.test.ts`,
`apps/api/src/whatsapp.security.test.ts`, this file.

Phase 5 remains `FROZEN` — this amendment fixes a real defect in already-shipped behavior rather than
adding new scope; `PHASE-CONTRACTS.json`'s phase 5 acceptance record is left as the historical
snapshot of the original freeze (§8 above), not rewritten.

Noticed but out of scope for this fix (pre-existing, not introduced by this amendment, not touched):
`whatsappReply.ts`'s `formatCollectedSummary` formats the completion-summary date using the server's
local timezone rather than the pickup location's; the WhatsApp idempotency key is saved before Steps
2-4 run, so a mid-pipeline failure after a successful Step 1 leaves that turn stuck until a new
message arrives; an empty/whitespace-only message gets the "too long" reply text instead of an
"empty" one; the webhook's `NOT_CONFIGURED` gate checks only `WHATSAPP_APP_SECRET`, not all four
required env vars together.
