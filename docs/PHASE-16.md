# Phase 16 — Automatic Steps 5-8 chaining + Conversation Engine v2

Status: **IN_PROGRESS** (implementation + automated gates done; e2e/Playwright and an independent
code review are not, so this phase is not frozen — see §8)

## 1. Pre-flight

- Read `CLAUDE.md`, `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`,
  `docs/PILOT-READINESS-REPORT.md`, `docs/PHASE-11.md` … `docs/PHASE-14.md`.
- **The gap this phase closes** is the one the pilot-readiness report (§5) named as "the single
  highest-leverage change": `runFullEnquiryPipeline` (WhatsApp and Email) only ran Steps 1-4 by
  itself. Steps 5-8 (Eligibility, Availability, Alternatives, Quote) existed, but a person had to
  call each endpoint, so a customer who finished Step 4 sat in `ELIGIBILITY_CHECK` forever.
- **Why it could not simply be wired:** Step 5 needs the driver's date of birth, nationality,
  licence type/validity and passport — data Step 4 never collects and that Step 5 refuses to
  derive from raw text. And nothing produced customer-facing wording for Steps 5-8 (the reply
  engine only understood Step 4's result).
- Baseline before changing anything: `pnpm typecheck` green, `pnpm test:unit` green (all packages).

Numbering: appended as id 16 (same "next free integer" precedent as ids 11-15).

## 2. Scope

In scope:

1. **Driver-detail intake over chat** (`EligibilityIntake`): after Step 4 completes the concierge
   asks for exactly what is still missing, in any order, over as many messages as the customer
   likes. Deterministic extraction (`packages/ai/src/step5/intake`) is the always-on baseline;
   Gemini (`geminiIntakeExtractor.ts`) fills only facts the parser left unresolved, and only
   accepts a value that comes with a **verbatim evidence quote** from the customer's own message.
   Ambiguous input (`03/04/1990`, two nationalities in one sentence) is never guessed — the
   customer is asked again. A bare "yes"/"no" only binds to the single open yes/no question.
2. **The chain** (`journeyAutopilotService.ts`): Step 5 -> 6 (places a hold) -> 8 (quote), or
   Step 7 when the car is not free; if the customer then picks an alternative, Step 6 -> 8 re-runs
   for it. Every hop calls the exact same step service and `record*Outcome` function the REST
   endpoints use, so state, audit events, CRM timeline and escalation rules are identical to a
   journey advanced by staff.
3. **Human hand-off wherever the concierge cannot or should not decide** (all reuse the existing
   `EscalationCase` + Twilio page + dashboard queue): the customer asks for a person; a message
   classified as a complaint; the customer accepts a quote (Steps 9-19 — documents, payment,
   confirmation — are not automated, so a person takes over); an expired quote; a missing
   eligibility policy or any unexpected step failure; a fleet-provider outage; repeated
   unanswered requests for driver details (4). `NEEDS_HUMAN_REVIEW` eligibility and
   `PENDING_REVIEW` quotes keep their existing T3 routing.
4. **Conversation engine v2** (`journeyReplyService.ts`, `conversationTurnService.ts`):
   - a deterministic **draft** is built from verified data for every stage (always a correct reply
     on its own); Gemini is asked only to rewrite it warmly, in the customer's language, with the
     whole two-sided conversation as context;
   - the model's output is never trusted (`checkGrounding`): any changed/added number, a dropped
     total, a "booking confirmed" claim, a callback-time promise, a link, or non-ASCII digits sends
     the draft instead — as do timeouts, provider errors, malformed JSON and an open circuit;
   - the concierge's own replies are now stored (`OutboundMessage`), so the model sees both sides
     and the customer's history shows exactly what they were told;
   - WhatsApp and Email share one `handleInboundTurn`, so both channels get identical behaviour.
5. **Data / platform:** migration `20260926130000_add_eligibility_intake_and_outbound_messages`
   (two tenant-scoped tables, `FORCE ROW LEVEL SECURITY`, API role has no `DELETE`); date of
   birth is AES-256-GCM encrypted at rest with a purpose-separated HKDF subkey (`deriveSubKey`,
   optional `PII_ENCRYPTION_KEY`); `findOpenConversationForCustomer` now keeps a conversation open
   while its journey is live (previously Step 4 `COMPLETE` closed it, which would have thrown the
   customer's next reply into a brand-new conversation) and closes it after 72h idle;
   `GEMINI_THINKING_LEVEL` (default `low`) with automatic retry-without if the API rejects it.

Out of scope (still PENDING, unchanged): documents, payments, delivery/return, invoice, follow-up
(journey Steps 9-19), the Customer PWA, web chat, an "email retry/resend" feature, and staff-side
reply composition from the dashboard.

## 3. Behaviour

| Journey state on message | What happens | Customer sees |
| --- | --- | --- |
| Steps 1-4 incomplete | unchanged Step 4 loop | the Step 4 question |
| `ELIGIBILITY_CHECK`, details incomplete | extract + persist, ask only what is missing | the missing items |
| `ELIGIBILITY_CHECK`, complete | Step 5; `ELIGIBLE` continues, `INELIGIBLE` -> `DECLINED`, review -> `ESCALATED` | next step / polite decline / hand-off |
| `AVAILABILITY_CHECK` | Step 6 hold, then Step 8 quote (or Step 7) | quote with exact total, deposit, validity, hold expiry |
| `OFFERING_ALTERNATIVES` | same car -> re-offer; a different car -> Step 6 -> 8 | alternatives / quote |
| `QUOTE_ISSUED` | acceptance -> hand-off; otherwise a grounded answer about the quote | hand-off / current quote |
| `ESCALATED` | acknowledge only, never a second case | "a team member is already looking after this" |

## 4. Files

- `packages/domain/src/eligibilityIntake.ts` — intake schema, `findMissingEligibilityFields`,
  `toEligibilityCustomerInput` (single source of truth for "complete").
- `packages/ai/src/step5/intake/{countries,intakeExtractor,geminiIntakeExtractor}.ts`.
- `packages/db` — `EligibilityIntake`, `OutboundMessage` models + repositories, migration,
  `findLatestAlternativeRecommendationForConversation`, journey-aware `findOpenConversationForCustomer`.
- `packages/security/src/crypto.ts` — `deriveSubKey`.
- `apps/api/src/services/` — `eligibilityIntakeService`, `journeyAutopilotService`,
  `journeyProgress`, `journeyReplyService`, `conversationTurnService`; `journeyService.escalateJourney`.
- `apps/api/src/routes/webhooks/{whatsapp,email}.ts` — now thin: signature, idempotency claim,
  `handleInboundTurn`, send, audit.

## 5. Tests

- Unit: extractor (incl. quoted-reply stripping), Gemini extractor grounding, reply drafts and the
  grounding guard, autopilot intent detectors, domain intake, `deriveSubKey`, Gemini provider
  thinking-level behaviour.
- Integration (real PostgreSQL 15 + Redis, driven through the signed WhatsApp webhook, nothing
  calls a step endpoint): first message -> issued quote with hold, CRM and encrypted DOB; piecemeal
  and bare answers; ambiguous date; ineligible driver; alternatives then a picked car; accepted
  quote -> single escalation -> acknowledge-only; quote follow-up; human request; missing policy;
  stalled details; scripted Gemini extracting from French and rewording; a hallucinated price never
  reaching the customer. Plus repository tests and an RLS-metadata test for the new tables.

## 6. Security review

- DOB encrypted at rest; never logged (logs carry ids/stages only); the LLM sees only the sanitised
  latest customer message; injection phrases are stripped before any prompt.
- The model can propose but never decide: eligibility, availability and price come from the
  deterministic steps; extraction requires verbatim evidence; the reply is grounded or discarded.
- New tables are tenant-scoped with forced RLS; no `DELETE` grant. Claims are the customer's own —
  the reply says eligibility is a pre-check and documents are verified before handover.

## 7. Configuration

`PII_ENCRYPTION_KEY` (optional, base64 32 bytes; falls back to an HKDF subkey of
`MFA_ENCRYPTION_KEY`), `GEMINI_THINKING_LEVEL` (default `low`), `GEMINI_MODEL_ID` (default
`gemini-3.8-flash`; `gemini-3.1-flash-lite` is the 3.1 model — there is no plain `gemini-3.1-flash`).
Everything else is unchanged; every provider still reports `NOT_CONFIGURED` rather than faking.

## 8. Known limits (honest list)

- **Not frozen.** Playwright e2e was not run (no web/UI change) and there has been no independent
  code review — only the author's own review.
- Steps 9-19 do not exist: an accepted quote ends in a human hand-off by design.
- The quote and its availability hold are still independent (a quote expiring does not release the
  hold) — pre-existing, `docs/PHASE-14.md` §9.
- The customer's details are claims until a document step verifies them.
- Live Gemini behaviour (model id, `thinkingLevel` field) could not be exercised without an API key;
  the provider retries without `thinkingConfig` if it is rejected, and every path falls back to the
  deterministic draft.
- The RLS/scoped-role cutover (`docs/PILOT-READINESS-REPORT.md` §6) is unchanged.
