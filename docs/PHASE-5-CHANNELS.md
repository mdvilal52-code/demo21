# Phase 5 (in progress) — WhatsApp Channel + Automated Step 1-4 Pipeline

Status: **IN_PROGRESS** (first slice of `PHASE-CONTRACTS.json` id 5,
"Channels, Documents, Payments, CRM & Fulfilment" — not FROZEN; see §2 for exactly what is and
isn't in this slice)

> **Renamed 2026-09-23** from `docs/PHASE-5.md` to `docs/PHASE-5-CHANNELS.md` to make room for
> `docs/PHASE-5.md` documenting journey Step 5 (Eligibility) — a separate, journey-step-numbered
> phase, matching the numbering Phases 1-4 already used (see `PHASE-CONTRACTS.json`'s
> `phaseNumbering` note and this doc's own §13). This file's content and scope are otherwise
> unchanged; the contract-id-5 "Channels, Documents, Payments, CRM & Fulfilment" phase this
> documents is still `IN_PROGRESS`, unaffected by the rename.

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`, `docs/MASTER-PLAN.md`.
- Read `docs/PHASE-4.md` (previous phase) and its §13 forward contract, which named journey Step 5
  (Eligibility) as the "correct" next journey step per the numbering Phases 1-4 actually followed,
  while flagging that `PHASE-CONTRACTS.json`'s own phase-id-5 entry is still the original 10-phase
  placeholder ("Channels, Documents, Payments, CRM & Fulfilment"), not yet reconciled.
- This phase was explicitly requested out of that order: the user asked for a working WhatsApp
  demo of Steps 1-4 before Eligibility (Step 5) exists. Scoped narrowly to exactly that (WhatsApp
  inbound/outbound + automatic Step 1-4 orchestration), not the full original phase-id-5 deliverable
  list — see §2.
- Inspected the repository; local PostgreSQL 16 + Redis 7 confirmed reachable; ran the existing
  Phase 1-4 suite before changing anything (407-test baseline green).

## 2. Scope

Goal: a customer can message a real WhatsApp number, and Steps 1-4 (already frozen, unchanged)
run automatically against that one message, replying over WhatsApp with whatever Step 4 actually
determined — a clarification question, or an acknowledgement once nothing is missing.

**In scope (built this phase):**

- Real WhatsApp (Meta Cloud API) inbound webhook: verification handshake, signature verification,
  message parsing.
- Real WhatsApp outbound send (`MetaWhatsAppProvider`), with an explicit `NotConfiguredWhatsAppProvider`
  when no credentials are set — never a fake send.
- `runFullEnquiryPipeline`: a fixed, hardcoded sequence that calls Steps 1-4's own already-tested
  service functions in order for one message. This is **not** the real Event/Workflow Engine
  (MASTER-PLAN.md's persisted journey state machine) — it is a single-message convenience sequence
  with no state machine, no resumability across multiple customer replies, and no support for the
  15 journey steps after Step 4.
- A deterministic, template-based WhatsApp reply builder (never an LLM call).

**Out of scope (deferred, still PENDING):**

- Web chat (SSE) and Email adapters — `PHASE-CONTRACTS.json` id 5's other channel deliverables.
- Document pipeline, `PaymentProvider`, CRM adapter, delivery/return coordination, invoice PDF,
  follow-up scheduler — the rest of id 5's deliverable list.
- Journey Step 5 (Eligibility) and everything after it.
- The real Event/Workflow Engine (persisted state machine, retries, timeouts, saga compensation) —
  still not built; unchanged from every prior phase's notes. §3/§9 below cover conversation
  continuation across WhatsApp turns, added mid-phase in response to a live bug report — a targeted
  fix scoped to "which conversation does a message belong to and what text do Steps 1-3 read", not
  the persisted, resumable, 19-step journey state machine that section of MASTER-PLAN.md still names.

## 3. Design decisions

- **Channel-agnostic pipeline, channel-specific adapter.** `runFullEnquiryPipeline`
  (`apps/api/src/services/enquiryPipelineService.ts`) takes `{ tenantId, channel, customerRef,
message }` and calls `submitEnquiry` → `extractDatesAndLocation` → `determineVehicle` →
  `checkMissingInfo` — the exact same four functions each REST endpoint already calls. Nothing in
  this phase re-implements Steps 1-4's logic; a future Web chat or Email adapter reuses the same
  pipeline function.
- **A message continues the customer's open conversation on this channel, added mid-phase.** The
  original version of this bullet shipped "every inbound message is a new enquiry" and left
  conversation continuation to the not-yet-built Event/Workflow Engine. In practice this produced a
  reproducible defect against a live WhatsApp number: a follow-up like "25 sept to 29 sept" carries
  no `BOOKING_REQUEST` keyword on its own (`packages/ai/src/lexicon.ts`), so Step 1 classified it
  `UNKNOWN` in isolation and Step 4 fell back to the generic `NOT_APPLICABLE` reply
  ("Thanks for reaching out — let us know if you'd like to book a car…") on every turn, no matter
  what an earlier message had already established. Fixed narrowly, without touching Steps 1-4's own
  engines or the real journey state machine's scope: `findOpenConversationForCustomer`
  (`packages/db/src/repositories/conversationRepository.ts`) finds the customer's most recent
  conversation on this channel unless it already reached a terminal Step 4 outcome
  (`COMPLETE`/`EXPIRED`), derived from the latest message's latest `MissingInfoCheck` — no new
  column. `continueEnquiry` (`enquiryService.ts`, a sibling to `submitEnquiry`) appends the message
  and re-runs Step 1 against the conversation's accumulated transcript rather than this message
  alone; `dateLocationService.ts`/`vehicleService.ts` do the same for Steps 2-3 via
  `buildAccumulatedTranscript` (`apps/api/src/lib/conversationTranscript.ts`, bounded to the most
  recent 25 messages / 8000 characters). `runFullEnquiryPipeline` does the open-conversation lookup
  itself and branches internally, so its own external contract and every caller (today, only the
  WhatsApp route) are unchanged. Still not the persisted, resumable Event/Workflow Engine —
  this is one hardcoded pipeline function reading further back than "the latest message", not a
  state machine — and still has one accepted, narrow gap: see §9.
- **A result object, not a thrown error, for outbound sends.** `WhatsAppProvider.sendTextMessage`
  returns `{ status: 'SENT' | 'NOT_CONFIGURED' | 'FAILED', ... }` rather than throwing. A failed or
  absent outbound send must never fail the inbound webhook ack Meta is waiting on; every branch is
  explicit and audited, never a fake `SENT`.
- **The Graph API host is hardcoded, not config-driven.** `MetaWhatsAppProvider` calls exactly
  `graph.facebook.com` via `ssrfSafeFetch`, independent of the generic `OUTBOUND_ALLOWED_HOSTS` env
  var — least privilege: this provider can reach exactly one third-party host, ever.
- **Signature verification runs against the raw request body**, captured by a Fastify content-type
  parser scoped to only the `/webhooks/whatsapp` routes (Fastify's plugin encapsulation leaves
  every other route's default JSON parsing untouched). The POST route deliberately has no `body`
  schema — shape validation happens manually, after signature verification, never before.
- **Claim-before-work idempotency, not check-then-act.** The pipeline plus an outbound HTTP call
  can take seconds; Meta redelivers a webhook that hasn't answered fast enough. An initial design
  (`find` the idempotency key, run everything, `save` it at the end) left a wide window for two
  concurrent deliveries to both run the pipeline and both send a reply — caught by this phase's own
  `/code-review` gate (see §5) before it shipped. Fixed with `claimIdempotencyKey` (an atomic
  insert — two racing requests can't both win it), `completeIdempotencyKey` on success, and
  `releaseIdempotencyKeyClaim` on failure so a genuine retry isn't stuck behind a claim that will
  never complete. Proven with a truly concurrent (`Promise.all`) redelivery test, not just a
  sequential one.
- **Exact-64-hex-character signature check.** Node's `Buffer.from(str, 'hex')` silently stops
  decoding at the first invalid character rather than rejecting the string, so a well-formed
  64-character signature with trailing garbage appended would otherwise still decode to the
  correct 32 bytes and pass comparison. Not itself a forgery path (an attacker would already need
  the real signature to build such a string), but closed outright rather than left as a curiosity —
  found by this phase's own security tests.
- **Phase 1's intent lexicon is unchanged.** The exact phrase used in the original request for this
  phase — "Hi I wants Lamborghini Urus 15-19 Oct, Dubai" — contains no keyword from
  `BOOKING_REQUEST`'s list (`book`, `rent`, `reserve`, `hire`, `reservation`, or the exact phrases
  "i need a car"/"i want a car") and so classifies as a non-booking intent (`NOT_APPLICABLE` at
  Step 4), not a bug introduced here. Broadening Phase 1's frozen, already-tested lexicon (e.g. so
  naming a specific vehicle also counts as booking evidence) is a real, reasonable product
  improvement, but a keyword-scored classifier can have non-obvious ripple effects on _other_
  intents' classification — exactly the kind of change `docs/PHASE-EXECUTION-PROTOCOL.md`'s "do
  only the current phase" / "preserve backward compatibility" rules guard against making casually.
  Left untouched; flagged for the user to decide. This phase's own tests and demo instructions use
  an explicit verb ("I want to **rent** a Lamborghini Urus..."), matching the phrasing the existing
  Phase 1-4 test suite already uses throughout.

## 4. What was built

- `packages/channels` (new package) — `src/whatsapp/types.ts` (tolerant Zod schema for Meta's
  webhook envelope), `inboundParser.ts` (`parseWhatsAppTextMessages`), `signature.ts`
  (`verifyMetaSignature`), `provider.ts` (`WhatsAppProvider`, `NotConfiguredWhatsAppProvider`,
  `MetaWhatsAppProvider`), `replyBuilder.ts` (`buildWhatsAppReplyText`).
- `apps/api/src/services/enquiryPipelineService.ts` — `runFullEnquiryPipeline`, now also doing the
  open-conversation lookup and continue-vs-fresh branch described in §3.
- `packages/db/src/repositories/conversationRepository.ts` — additive: `findMessagesForConversation`,
  `appendMessageToConversation`, `findOpenConversationForCustomer`.
- `apps/api/src/services/enquiryService.ts` — additive: `continueEnquiry`.
- `apps/api/src/lib/conversationTranscript.ts` — `buildAccumulatedTranscript`.
- `apps/api/src/routes/webhooks/whatsapp.ts` — `GET /webhooks/whatsapp` (verification handshake),
  `POST /webhooks/whatsapp` (inbound message processing).
- `packages/db/src/repositories/idempotencyRepository.ts` — additive: `claimIdempotencyKey`,
  `completeIdempotencyKey`, `releaseIdempotencyKeyClaim` (existing `findIdempotencyKey`/
  `saveIdempotencyKey`, used by Step 1's own endpoint, unchanged).
- `packages/contracts/src/whatsapp.ts` — `whatsappVerifyQuerySchema`,
  `whatsappInboundAckResponseSchema`.
- `apps/api/src/env.ts` — `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`,
  `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION` (all optional; unset ⇒ `NOT_CONFIGURED`).
- `apps/api/src/context.ts`, `server.ts`, `app.ts` — `whatsappProvider` wired into `AppContext`;
  new route registered.
- `.env.example`, `render.yaml` — new WhatsApp variables documented, with where each one comes from
  in the Meta dashboard.

No Prisma migration — `IdempotencyKey` (Phase 1) is reused as-is; no schema change.

## 5. APIs

| Method | Path                 | Purpose                                                                               |
| ------ | -------------------- | ------------------------------------------------------------------------------------- |
| GET    | `/webhooks/whatsapp` | Meta's webhook verification handshake (`hub.mode`/`hub.verify_token`/`hub.challenge`) |
| POST   | `/webhooks/whatsapp` | Inbound WhatsApp message(s); runs Steps 1-4 and replies over WhatsApp                 |

Request/response schemas: `packages/contracts/src/whatsapp.ts`; live in the OpenAPI doc at `/docs`.

## 6. Database schema

No new tables or migrations. `IdempotencyKey` (Phase 1, `packages/db/prisma/schema.prisma`) gained
three additive repository functions in `idempotencyRepository.ts` (claim/complete/release) — the
table shape is unchanged; a claimed-but-not-yet-completed row is simply one with
`responseStatus: 0, responseBody: {}` until `completeIdempotencyKey` fills in the real outcome.

## 7. Security decisions

**Implemented and tested:**

- **Webhook authenticity.** `X-Hub-Signature-256` verified against the raw request body (captured
  before JSON parsing) with a constant-time compare; exact-64-hex-character check (see §3);
  missing/wrong secret is `501 NOT_CONFIGURED` / `401 UNAUTHORIZED`, never processed.
- **Never trusts the webhook payload's shape.** `parseWhatsAppTextMessages` tolerates missing
  fields, wrong types, delivery-status callbacks, and non-text message types — proven with
  prototype-pollution-shaped keys, wrong-typed `entry`/`changes`/`messages`, and malformed JSON,
  none of which throw or crash the process.
- **Idempotent by Meta's own message id**, claimed atomically before any work starts (see §3);
  proven with a genuinely concurrent redelivery, not just a sequential one.
- **Outbound egress restricted to exactly one host** (`graph.facebook.com`), via `ssrfSafeFetch`,
  independent of the generic outbound allowlist.
- **Never a fake send.** `NotConfiguredWhatsAppProvider`/a Graph API error both return an explicit,
  audited, non-`SENT` status — the webhook still acks 200 (Meta's requirement), but nothing claims
  a message went out that didn't.
- **Prompt-injection / SQL-injection visibility carried through unchanged** — the WhatsApp message
  body flows into the exact same `submitEnquiry` → `RuleBasedIntentEngine.recognize` path Step 1
  already sanitizes and audits; proven end to end with both payload types reaching the webhook.
- **Audit event on every reply** (`whatsapp.reply_sent`) in addition to each reused step's own
  existing audit events.
- **Zod-validated at every new boundary** — the Meta webhook envelope, the verification
  querystring, the ack response.

**Explicitly deferred (documented, not silently skipped):**

- Database-level Row Level Security — still application-level only, unchanged from Phases 1-4.
- A real conversational loop / journey resumption (§2) — Event/Workflow Engine scope.
- Rate limiting specific to the webhook path beyond the API-wide `@fastify/rate-limit` — Meta's own
  retry/backoff behavior is trusted for now; a dedicated per-sender limit is Phase 6 (Security
  Engine & Zero Trust) scope.

## 8. Test results

All commands run against real local PostgreSQL 16 + Redis 7 (same sandbox as Phases 1-4; Docker
daemon still unavailable here).

| Gate                | Command                        | Result                                                                                            |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Typecheck           | `pnpm typecheck`               | ✅ 12/12 packages                                                                                 |
| Lint                | `pnpm lint`                    | ✅ 0 errors, 0 warnings                                                                           |
| Format              | `pnpm format:check`            | ✅ clean                                                                                          |
| Unit                | `pnpm test:unit`               | ✅ 347 tests                                                                                      |
| Integration         | `pnpm test:integration`        | ✅ 90 tests                                                                                       |
| Security            | `pnpm test:security`           | ✅ 57 tests                                                                                       |
| E2E                 | `pnpm test:e2e`                | ✅ 4 tests, unchanged (no UI touched)                                                             |
| Build               | `pnpm build`                   | ✅ every package (incl. `@ai-concierge/channels`) + Next.js                                       |
| Code review         | `/code-review` (medium/high)   | ✅ idempotency race fixed pre-freeze; conversation-continuity fix reviewed separately (see below) |
| Architecture review | checklist vs MASTER-PLAN §1/§6 | ✅ matches target `packages/channels` responsibility; no deviations                               |
| Regression          | `pnpm test` (final commit)     | ✅ full Phase 1-4 suite + this phase's, all green                                                 |

**Total: 498 automated tests, all passing** (current, freshly re-run against real local
PostgreSQL 16 + Redis 7 as every count above and below was measured directly this session — see the
conversation-continuity fix below for what's new since this table was first written).

Key new scenarios (`apps/api/src/whatsapp.integration.test.ts`,
`apps/api/src/whatsapp.security.test.ts`, `packages/channels/src/whatsapp/*.test.ts`):

| Case                                                                | Result                                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Meta verification handshake (correct/wrong token, wrong `hub.mode`) | 200 + echoed challenge / 403                                                                              |
| Real fleet vehicle + real dates + real location in one message      | Steps 1-4 all run; `COMPLETE`; WhatsApp reply names the vehicle                                           |
| Only a vehicle mentioned, no dates/location                         | `NEEDS_INFO`; WhatsApp reply is the exact clarification prompt                                            |
| Redelivered message id (sequential, then genuinely concurrent)      | processed exactly once; exactly one reply sent                                                            |
| Delivery-status callback (no `messages` array)                      | 200 ack, nothing processed, nothing sent                                                                  |
| Missing / wrong / tampered / non-hex-length signature               | 401, no processing, no internal detail leaked                                                             |
| No `WHATSAPP_APP_SECRET` / `WHATSAPP_VERIFY_TOKEN` configured       | 501 `NOT_CONFIGURED`, never a fake success                                                                |
| Prompt injection / SQL injection in the message body                | flagged / inert, exactly as Steps 1-4 already prove                                                       |
| Malformed JSON body                                                 | 400, not a 500 crash                                                                                      |
| Prototype-pollution-shaped / wrong-typed webhook payload            | parses to nothing, never throws                                                                           |
| Two-turn conversation: vehicle-only, then dates/location-only       | one conversation, two messages; turn 2 reaches `COMPLETE`, not a repeat of turn 1 or the generic fallback |
| Prompt injection introduced in turn 2 of an ongoing conversation    | still flagged, even though turn 1 alone was clean                                                         |
| 30-message flood from one customer in one conversation              | stays bounded (transcript capped), one conversation, no crash                                             |
| A conversation that already completed, then a new message           | starts a second, separate conversation for the same customer                                              |
| Two different customers messaging around the same time              | two separate conversations, never merged                                                                  |

## 9. Known limitations

- **Conversation continuation has a narrow concurrent-delivery race.** `findOpenConversationForCustomer`
  is read outside the pipeline's own transactions, so two genuinely simultaneous messages from the
  same customer (not the same redelivered message id — that race is fully closed by §3's
  claim-before-work idempotency) could each see "nothing open" and start their own conversation. Real
  WhatsApp replies from one person are seconds-to-minutes apart in practice, not concurrent, so this
  is accepted and documented rather than engineered around with locking — the same tradeoff this
  phase already made for idempotency before landing on claim-before-work (§3), just not worth the
  same fix here given how much less likely genuine concurrency is for two _different_ messages than
  for one redelivered one.
- **Still no persisted, resumable journey state machine.** Conversation continuation (§3) reads
  further back than "the latest message" for one hardcoded pipeline function; it's still not the
  Event/Workflow Engine's per-step state, retries, timeouts, or saga compensation.
- **Intent classification is keyword-based and English-only** (unchanged from Phase 1).
  ~~A message naming only a vehicle and dates, with no booking verb, still classifies as a
  non-booking enquiry (`NOT_APPLICABLE`) on its own... a customer whose very first message never
  does still hits this.~~ **Partially fixed 2026-09-21, see §14**: a bare affirmative reply
  ("Yes") to the generic invitation now progresses instead of repeating it. A message that never
  contains a booking verb _and_ is never a plain "Yes" (e.g. a vehicle name with no confirmation
  either way) still falls back to `NOT_APPLICABLE` — broadening the lexicon itself remains a
  decision left to the user.
- **No per-sender rate limiting on the webhook** beyond the API-wide limiter — see §7.
- **`MetaWhatsAppProvider` is untested against the real Meta API** in this sandbox (no real
  WhatsApp Business credentials available here) — its HTTP call shape, headers, and response
  parsing are unit-tested against a fake `fetch`, and the adapter reports `NOT_CONFIGURED` until a
  real `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` are supplied, per the "never fake a
  working integration" rule. See the runbook in the final chat summary for how to plug in real
  credentials and verify it end to end against Meta.
- **No Docker daemon in this dev sandbox** (same as Phases 1-4) — `docker-compose.yml` unaffected.

## 10. Files created

- `packages/channels/**` (package.json, tsconfig.json, `src/whatsapp/{types,inboundParser,
signature,provider,replyBuilder}.ts` + matching `.test.ts` + `whatsapp.security.test.ts`)
- `apps/api/src/services/enquiryPipelineService.ts`
- `apps/api/src/routes/webhooks/whatsapp.ts`
- `apps/api/src/test/fakeWhatsAppProvider.ts`
- `apps/api/src/whatsapp.integration.test.ts`, `apps/api/src/whatsapp.security.test.ts`
- `packages/contracts/src/whatsapp.ts`
- `apps/api/src/lib/conversationTranscript.ts` (+ `.test.ts`)
- `apps/api/src/services/enquiryPipelineService.test.ts`
- `docs/PHASE-5-CHANNELS.md` (this file, originally `docs/PHASE-5.md` — renamed 2026-09-23, see the
  note at the top of this document)

## 11. Files modified

- `packages/db/src/repositories/idempotencyRepository.ts` (+ `.test.ts`) — additive
  claim/complete/release functions.
- `apps/api/src/env.ts`, `context.ts`, `server.ts`, `app.ts`, `test/buildTestApp.ts` — WhatsApp
  config/provider wired through; existing behavior unchanged (`NotConfiguredWhatsAppProvider` by
  default).
- `packages/contracts/src/index.ts` — new export added.
- `apps/api/package.json` — `@ai-concierge/channels` dependency added.
- `.env.example`, `render.yaml` — new optional WhatsApp variables documented.
- `docs/ARCHITECTURE.md`, `docs/PHASE-CONTRACTS.json` — updated for this phase.
- `packages/db/src/repositories/conversationRepository.ts` (+ `.test.ts`) — additive
  `findMessagesForConversation`/`appendMessageToConversation`/`findOpenConversationForCustomer`.
- `apps/api/src/services/enquiryService.ts` (+ `.test.ts`) — additive `continueEnquiry`.
- `apps/api/src/services/dateLocationService.ts`/`vehicleService.ts` (+ `.test.ts`) — extract from
  the conversation's accumulated transcript instead of only the latest message (§3).
- `apps/api/src/services/enquiryPipelineService.ts` — open-conversation lookup and branch (§3).
- `apps/api/src/whatsapp.integration.test.ts`, `apps/api/src/whatsapp.security.test.ts` — new
  multi-turn/flood/isolation cases (§8).

No working Phase 1-4 functionality was changed; `pnpm test` (full regression) re-run green on the
final commit.

## 12. Migration status

No new migration this phase (see §6).

## 13. Next steps (proposed, not started)

Per `docs/PHASE-4.md` §13 and `MASTER-PLAN.md` §4, journey Step 5 is **Eligibility**
(`ELIGIBILITY_CHECK`) — still the logically "correct" next journey step. Separately, the remainder
of this phase's original id-5 scope (Web chat/Email adapters, documents, payments, CRM,
delivery/return) is still `PENDING`. Two open decisions for the user, not made unilaterally here:

1. Broaden Phase 1's intent lexicon so a message naming a specific vehicle (with no explicit
   booking verb) also counts as booking evidence — see §3/§9.
2. Which comes next: Eligibility (Step 5), the rest of the channels/documents/payments/CRM phase,
   or the real Event/Workflow Engine (needed for the conversational-loop gap in §9).

Do not start either until asked.

## 14. Follow-up fix — 2026-09-21 — a bare "Yes" still repeated the initial greeting

Same "added mid-phase in response to a live bug report" pattern §3 already describes for
conversation continuation itself — this phase is still `IN_PROGRESS`, and this closes a gap that
fix left open (flagged explicitly in §9 at the time: "Left to the user to decide"), not a new phase
or a change of scope.

### Reported bug

```
Customer: Hiii
AI:       Thanks for reaching out — let us know if you'd like to book a car and we'll take it from there.
Customer: Yes
AI:       [the exact same message, repeated]
```

### Why §3's conversation-continuation fix didn't cover this

Verified empirically (real webhook, real signature, real DB, `app.inject`) before writing any code:
`continueEnquiry` re-runs Step 1 against the accumulated transcript (`buildAccumulatedTranscript`),
so a follow-up like "15 to 19 Oct" resolves correctly _once an earlier turn already contained a
booking verb_ ("I want to rent a Lamborghini Urus", per §8's own multi-turn test). But "Hiii" and
"Yes" both carry zero `BOOKING_REQUEST` keywords, and joining them into one transcript ("Hiii\nYes")
still doesn't create one — `RequiredFieldsEvaluator` (unchanged, `packages/ai`) short-circuits to
`NOT_APPLICABLE` whenever `intentType !== BOOKING_REQUEST`, so Step 4 sent the identical generic
reply a second time. This is exactly what §9's "Intent classification is keyword-based" bullet
already flagged as a known, deliberately-deferred gap.

### Fix

- **`packages/ai/src/replyIntent.ts`** (new): `classifyShortReply` — a small, deterministic
  AFFIRMATIVE/NEGATIVE/UNCLEAR classifier for a short reply, distinct from `intent-engine.ts`'s
  keyword lexicon (which classifies what a message is _about_, not whether it answers a yes/no
  question). Word-boundary matching only; a bare `not` negates whatever affirmative-looking word
  follows or precedes it ("not correct", "definitely not"), not just a fixed "not now/interested"
  list. 38 unit tests.
- **`apps/api/src/services/enquiryService.ts`**: `continueEnquiry` now corrects the transcript-based
  classification to `BOOKING_REQUEST` when it came back `UNKNOWN` _and_ the new message is a plain
  affirmative reply (`isBookingConfirmationReply`) — deliberately scoped to `UNKNOWN` only, not
  "anything other than BOOKING_REQUEST", so a "Yes" answering a different already-recognized intent
  (COMPLAINT, SUPPORT_REQUEST, ...) is never silently reinterpreted as a booking confirmation.
  `confirmBookingIntent` recomputes `missingFields`/`status`/`clarificationPrompt` the same way
  `RuleBasedIntentEngine` itself would, so the persisted `IntentRecord` stays internally consistent,
  and tags `modelMetadata.engine` distinctly (`short-reply-confirmation-v1`) so the audit trail never
  implies the keyword engine matched a term it didn't. 4 new unit tests (correction fires on
  `UNKNOWN`; does not fire once already `BOOKING_REQUEST`; does not fire for a different recognized
  intent; does not fire for a non-affirmative reply).

No changes to `packages/channels`, the webhook route, `RequiredFieldsEvaluator`, or any Step 2/3
service — this only corrects what Step 1 hands to the already-existing, already-tested pipeline.

### Test results

Real local PostgreSQL 16 + Redis 7, real `app.inject`, real HMAC signatures — same discipline as §8.

| Gate        | Result                                                        |
| ----------- | ------------------------------------------------------------- |
| Typecheck   | ✅ 12/12 packages                                             |
| Lint        | ✅ 0 errors, 0 warnings                                       |
| Format      | ✅ clean                                                      |
| Unit        | ✅ all packages green (+42 tests over §8's 322-test baseline) |
| Integration | ✅ 91 tests (+1 over §8's 90)                                 |
| Security    | ✅ 57 tests — unchanged, all still passing                    |
| E2E         | ✅ 4 tests, unchanged (no UI touched)                         |
| Build       | ✅ every package + Next.js production build                   |

New permanent regression in `apps/api/src/whatsapp.integration.test.ts`: `'progresses on a bare
"Yes" instead of repeating the initial greeting reply (regression)'` — sends `Hiii` then `Yes` as two
separate signed webhook deliveries from the same customer, asserts the second reply differs from the
first and is not the generic invitation text, and asserts the `Yes` message's own `IntentRecord`
shows `BOOKING_REQUEST`.

### Confirmation

Re-ran the exact reported scenario against this fix: `Hiii` → generic invitation; `Yes` → a
different reply asking for vehicle/pickup/return/location, never a repeat. Verified both before
(bug reproduced) and after (fixed) the code change, not just via the new test.

### Known, accepted limitation (not fixed here)

A message that never contains a booking verb _and_ is never a plain yes/no (e.g. just naming a
vehicle, with no confirmation either way, as the customer's very first message) still falls back to
the generic `NOT_APPLICABLE` reply — this fix only closes the yes/no-shaped gap, not §9's broader
"broaden the lexicon" decision, which stays explicitly left to the user.

**Superseded by §15, 2026-09-21**: the limitation above (a bare vehicle name, dates, or location with
no booking verb) is now fixed — see §15.2.

## 15. Follow-up fix — 2026-09-21 — conversation state, slot-filling, and cancel handling (full audit)

Same "added mid-phase" pattern as §14 — this phase is still `IN_PROGRESS`. A fuller audit requested
after §14 shipped: not just the exact reported "Yes" bug, but the underlying conversation-state
mechanism in general (any message shape, fields in any order, changing a value mid-flow, an unclear
reply, a side question, an explicit cancellation), following the example booking
Vehicle: Lamborghini Urus / Pickup: 25 Sep 2026 10:00 / Return: 28 Sep 2026 10:00 / Pickup location:
Dubai International Airport (DXB), Dubai throughout.

### 15.1 Method

Built a disposable diagnostic test harness (`app.inject` against a real local Postgres 16 + Redis 7,
real signed webhook payloads, two seeded fleet vehicles) and ran 12 mandatory scenarios (A-L: a plain
greeting; a bare "Yes"; a bare vehicle name; an unrelated reply that adds no information; a single
fully-structured message; a message using a booking verb; fields arriving in a different order across
turns; an unclear reply mid-booking; a redelivered webhook; changing the chosen vehicle mid-flow; a
side question mid-booking; an explicit cancellation) against the branch **as it stood after §14**,
before writing any fix, to find every remaining gap empirically rather than assuming §14 was
sufficient. 5 distinct root causes were found this way (15.2-15.3, 15.5-15.7); §14's own fix was
confirmed still correct and left untouched. Every fix below was then re-verified against the same 12
scenarios before the scratch harness was deleted and the valuable scenarios ported into permanent
tests (15.8).

### 15.2 Root cause 1 — Step 4's gate only ever looked at the latest message's own intent

`RequiredFieldsEvaluator.evaluate` (`packages/ai/src/step4/requiredFieldsEvaluator.ts`) returned
`NOT_APPLICABLE` — discarding whatever Steps 2-3 had already resolved — whenever the **latest**
message's own `intentType !== 'BOOKING_REQUEST'`, even though `RuleBasedIntentEngine` extracts
`entities` (vehicle/dates/location) independently of keyword-based `intentType` classification
(`intent-engine.ts`). A bare vehicle name ("Lamborghini Urus"), a date range alone, a location alone,
or fields arriving in a different order across turns all classify `UNKNOWN` on their own — only a
literal booking verb ("book"/"rent"/...) or §14's short-affirmative correction ever flipped this gate.

**Fix** — two layers, both additive, both covered by new tests:

- **`apps/api/src/services/enquiryService.ts`**: generalized §14's `isBookingConfirmationReply` into
  `shouldTreatAsBookingContinuation` — corrects an `UNKNOWN` classification to `BOOKING_REQUEST` when
  the new message is a short affirmative (§14, unchanged) **or** the accumulated transcript already
  has real booking-shaped entities (`hasBookingShapedEntities`) **or**, as a durable fallback once the
  accumulated transcript's bounded window has rolled the original booking-establishing message out of
  view on a long conversation, this conversation already had a `BOOKING_REQUEST` intent at some
  earlier point (`hasBookingRequestIntentInConversation`, new query in
  `packages/db/src/repositories/intentRepository.ts`). Applied to both `submitEnquiry` (a booking-shaped
  first message) and `continueEnquiry`. Still deliberately scoped to `UNKNOWN` only — a different,
  already-recognized intent (COMPLAINT, DOCUMENT_REQUEST, ...) is never silently overridden.
- **`packages/ai/src/step4/requiredFieldsEvaluator.ts`**: the `NOT_APPLICABLE` gate now also stays
  open when real progress already exists for the conversation (`hasExistingProgress` — a resolved
  vehicle, or a resolved pickup/return date, or a resolved pickup location), regardless of what the
  latest message's own intent classified as. This is what makes a side question mid-booking (15.6)
  re-ask the pending field instead of discarding the booking.

### 15.3 Root cause 2 — the vehicle-name heuristic misread ordinary text as a vehicle

`VehicleIntentService`'s fallback "does this look like a vehicle name" heuristic
(`packages/ai/src/step3/vehicleIntentService.ts`) had three separate false-positive shapes, all in the
same 2-3-capitalized-word / lone-capitalized-word proxy:

1. Its multi-word regex treated `\n` (how `buildAccumulatedTranscript` joins separate messages) as
   ordinary whitespace, so the last word of one message could merge with the first word of the next
   into one bogus phrase — a real customer-facing example from the audit: `"Hi\nYes" is not a vehicle
we currently offer`.
2. Its "not the very first word" sentence-initial exemption only checked absolute index 0 of the
   _whole_ accumulated transcript, so the first capitalized word of every message after the first
   ("Yes", "What", "Pickup", ...) was misread as a proper-noun signal purely for not being message 1.
3. A location phrase has the exact same shape as a vehicle name ("Pickup Dubai Airport", "Dubai
   Marina") — the heuristic had no way to tell them apart.

**Fix**, all in `vehicleIntentService.ts`: (1) the multi-word regex now requires horizontal whitespace
only (`[ \t]+`, never `\n`); (2) a new `isLineInitial` check treats the first word of _any_ line as
sentence-initial, not just absolute index 0; (3) a new `isLocationShapedPhrase` check reuses Step 1's
own `LOCATION_KEYWORDS` (`lexicon.ts`) to exclude a candidate phrase that reads as a location — checked
both directions (`"pickup dubai airport".includes("dubai airport")` and, for a phrase split down to
one word by (2), `"dubai airport".includes("airport")`). None of this touches the real fleet-matching
tiers (`matchExactModel`/`matchBrandOnly`/`matchCategoryOnly`), which match directly against the
tenant's lexicon and never go through this fallback heuristic.

### 15.4 Root cause 3 — changing vehicles mid-flow read as an unresolvable ambiguity

`matchExactModel` returns every fleet entry whose name appears anywhere in the accumulated transcript,
with no notion of recency — so "Urus" in one turn and "actually the Ferrari instead" in a later turn
produced **two** exact-model candidates, and `VehicleValidationService` correctly (given that input)
reported "2 vehicles matched; please choose one" instead of switching to the Ferrari.

**Fix** (`vehicleIntentService.ts`): each exact-model match now also records which line (message) of
the transcript it came from. When every match is on the same line, they were named together in one
message — genuinely ambiguous, left untouched. When they span more than one line, only the matches on
the _most recent_ line survive — a change of mind, not a request to choose between two options named
turns apart.

### 15.5 Root cause 4 — no cancellation handling at all

Nothing recognized an explicit cancellation; "cancel" mid-booking just landed in Step 4 as an
unclassified message (see 15.2's `hasExistingProgress` fix) and re-asked the next pending field
instead of acknowledging the cancellation.

**Fix**:

- New `IntentType.CANCEL_REQUEST` (`packages/domain/src/intent.ts` + a matching keyword list in
  `packages/ai/src/lexicon.ts`) and `MissingInfoStatus.CANCELLED` (`packages/domain/src/missingInfo.ts`)
  — additive-only Prisma migration
  `packages/db/prisma/migrations/20260921141125_add_cancel_request_and_cancelled_status/` (two
  `ALTER TYPE ... ADD VALUE`, no column/data changes).
- `RequiredFieldsEvaluator` returns `CANCELLED` when the intent is `CANCEL_REQUEST` **and** real
  progress exists to cancel (checked ahead of the normal COMPLETE/NEEDS_INFO evaluation, so
  cancelling wins even over an already-COMPLETE booking); a cancel request with nothing yet collected
  falls through to the ordinary `NOT_APPLICABLE` reply (nothing to cancel).
- `buildWhatsAppReplyText` (`packages/channels`) gets a dedicated `CANCELLED` reply.
- `findOpenConversationForCustomer` (`packages/db`) now also treats `CANCELLED` as terminal, so the
  next message after a cancellation starts a fresh conversation instead of continuing the cancelled one.
- **Bug caught by the intent-engine's own unit tests, not the audit harness**: "cancel my booking"
  classified as `BOOKING_REQUEST`, not `CANCEL_REQUEST` — `countMatches` scores each keyword-list
  entry independently, and "booking" contains "book" as a substring, so both count, out-scoring the
  single "cancel" match. Fixed narrowly in `classifyIntentType`
  (`packages/ai/src/intent-engine.ts`): when the normal keyword competition would otherwise pick
  `BOOKING_REQUEST` and any cancel keyword also matched, `CANCEL_REQUEST` wins — scoped to this one
  pair (the only keyword list with this substring-inflation shape), not a blanket override of every
  other intent type.

### 15.6 Root cause 5 (consequence of 15.2's second layer) — a side question mid-booking

"What documents do I need to rent a car?" mid-booking classified `DOCUMENT_REQUEST` (a real, correct
classification — "documents"/"what documents" are real Step 1 keywords) and, before 15.2's
`hasExistingProgress` fix, hit the `NOT_APPLICABLE` gate and replied with the generic "let us know if
you'd like to book a car" text — discarding the already-resolved vehicle and reading as a reset. Fixed
by 15.2's second layer: once real progress exists, evaluation proceeds and re-asks the same pending
field instead. This system still has no dedicated content for documents/pricing/support questions —
that gap is unchanged and explicitly out of scope here (see §15.9); the fix only stops it from
discarding an in-progress booking.

### 15.7 Separately found while implementing 15.6's logging — a pre-existing log-redaction gap

Implementing the structured decision-path logging this task also required (15.8) surfaced, and a new
smoke test confirmed, that `packages/observability/src/logger.ts`'s `REDACTED_PATHS` only redacted a
sensitive field name nested **one level deep** (`'*.secret'` matches `foo.secret`) — a **top-level**
`logger.info({ message: rawText, webhookSigningSecret: '...' }, '...')` call, the overwhelmingly
common shape used everywhere in this codebase, passed straight through unredacted. Fixed by listing
both the bare and `*.`-prefixed form of every sensitive field name; 3 new unit tests cover the
top-level case directly (`packages/observability/src/logger.test.ts`), and one pre-existing test
updated to match the now-stricter behavior (a nested `message` object is now redacted whole, not just
its `.content` child). This is a pre-existing gap in shared logging infrastructure, not something this
task's own new code had triggered — the new decision-path log call (15.8) was already written to
avoid logging raw customer text or secrets by construction; this closes the backstop for every other
caller too.

### 15.8 Structured decision-path logging

New `logPipelineDecision` (`apps/api/src/routes/webhooks/whatsapp.ts`), one line per processed
message: `requestId`, `conversationId`, `messageId` (opaque ids only, never the customer's phone
number), `intentType`, `intentStatus`, `decisionEngine` (`modelMetadata.engine` — reveals whether Step
1's raw keyword match or one of `enquiryService.ts`'s corrections produced this result),
`stage` (Step 4 `status`), `missingFields` (`field`/`reason` pairs only — deliberately never `detail`,
which can echo a fragment of the customer's own text, e.g. an unmatched vehicle name), and
`promptInjectionDetected`. Backstopped by 15.7's redaction fix.

### 15.9 Test results

Real local PostgreSQL 16 + Redis 7, real `app.inject`, real HMAC-signed webhook payloads, real
Playwright/Chromium — same discipline as §8/§14, run repeatedly through this round as each fix landed,
not just once at the end.

| Gate        | Result                                              |
| ----------- | --------------------------------------------------- |
| Typecheck   | ✅ every package + app                              |
| Lint        | ✅ 0 errors, 0 warnings                             |
| Format      | ✅ clean                                            |
| Unit        | ✅ 417 tests, all packages                          |
| Integration | ✅ 104 tests (db 51, api 51, worker 2)              |
| Security    | ✅ 57 tests — unchanged from §14, all still passing |
| E2E         | ✅ 4 tests, unchanged (no web UI touched)           |
| Build       | ✅ every package + Next.js production build         |

12/12 mandatory scenarios (A-L) re-verified passing end to end after every fix; the diagnostic harness
was then deleted and its scenarios ported into permanent tests: 7 new `it()` blocks in
`apps/api/src/whatsapp.integration.test.ts` (bare vehicle name + unclear "OK" re-ask; single
fully-structured message; fields in a different order incl. the location-false-positive regression;
unclear reply mid-booking; changing vehicles mid-flow; a side question mid-booking; cancellation), new
unit tests in `vehicleIntentService.test.ts` (8 new), `requiredFieldsEvaluator.test.ts` (7 new),
`intent-engine.test.ts` (3 new), `enquiryService.test.ts` (6 new), `replyBuilder.test.ts` (1 new),
`conversationRepository.test.ts` (extended), and a new `intentRepository.test.ts` (5 tests — this
repository had no dedicated test file before this round).

### 15.10 Files changed

**Modified**: `apps/api/src/routes/webhooks/whatsapp.ts`, `apps/api/src/services/enquiryService.ts`,
`apps/api/src/services/enquiryPipelineService.ts`, `apps/api/src/whatsapp.integration.test.ts`,
`packages/ai/src/intent-engine.ts`, `packages/ai/src/lexicon.ts`,
`packages/ai/src/step3/vehicleIntentService.ts`, `packages/ai/src/step4/requiredFieldsEvaluator.ts`,
`packages/channels/src/whatsapp/replyBuilder.ts`, `packages/db/prisma/schema.prisma`,
`packages/db/src/repositories/conversationRepository.ts`,
`packages/db/src/repositories/intentRepository.ts`, `packages/domain/src/intent.ts`,
`packages/domain/src/missingInfo.ts`, `packages/observability/src/logger.ts`, plus the `.test.ts`
companion of every file above.

**Added**: `packages/db/src/repositories/intentRepository.test.ts`, migration
`packages/db/prisma/migrations/20260921141125_add_cancel_request_and_cancelled_status/`.

**Rollback**: every schema change is additive (`ALTER TYPE ... ADD VALUE`, no column/data changes) —
reverting the code is safe without a down-migration; the two new enum values would simply become
unused. No existing endpoint, message, or persisted row shape changed.

### 15.11 Known limitations (carried forward, not fixed here)

- **No dedicated content for non-booking intents.** DOCUMENT_REQUEST, PRICE_REQUEST, COMPLAINT,
  SUPPORT_REQUEST, etc. still have no real answer beyond either the generic `NOT_APPLICABLE` reply (if
  nothing is in progress) or re-asking the pending booking field (15.6, if something is). Answering a
  document/pricing/support question substantively would need real product content this task was not
  given and should not invent — left to the user as a follow-up.
- **Step 1's `vehicleIntent` entity is a small hardcoded brand keyword list**
  (`packages/ai/src/lexicon.ts`'s `VEHICLE_KEYWORDS`), not fleet-driven — unlike Step 3, which always
  matches against the tenant's real fleet. Every vehicle in this task's fixture fleet (Lamborghini,
  Ferrari, ...) is covered, but a tenant with an entirely different fleet would need this list
  extended, or Step 1 made fleet-aware — a larger change than this task's minimal-fix mandate, and
  unchanged from Phase 1.
- **Keyword matching throughout `intent-engine.ts` is plain substring matching**, not word-bounded —
  a pre-existing characteristic of the whole lexicon (e.g. "different" already contained "rent" before
  this round), not something introduced or fixed here. `cancel` itself was checked for realistic
  collision words and found safe (every common word containing "cancel" as a substring — cancellation,
  cancelling, uncancellable — is itself about cancelling).
- Every limitation §9/§14 already listed and did not explicitly note as fixed above is still open
  (the concurrent-delivery race, no persisted journey state machine, no per-sender rate limit beyond
  the API-wide one, `MetaWhatsAppProvider` untested against the real Meta API, no Docker daemon in this
  sandbox).
