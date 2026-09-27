# Phase 16 — Automatic Steps 5-8 chaining + Conversation Engine v2

Status: **FROZEN** (2026-09-27) — implementation, Playwright e2e, two independent code-review
passes and the full gate pipeline (typecheck, lint, unit, integration, security, e2e, build, code
review, architecture review, regression) are all green — see §9.

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

Out of scope for this phase, still PENDING project-wide: documents, payments, delivery/return,
invoice, follow-up (journey Steps 9-19) — an accepted quote still ends in a human hand-off by
design. The Customer PWA, web chat, and staff-side reply composition from the dashboard were built
separately under Phase 17 (`docs/PHASE-17.md`). Email retry/resend — listed here as out of scope
when this phase was first written — was completed as an addendum to this phase; see §9.

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

- Steps 9-19 do not exist: an accepted quote ends in a human hand-off by design.
- The quote and its availability hold are still independent (a quote expiring does not release the
  hold) — pre-existing, `docs/PHASE-14.md` §9.
- The customer's details are claims until a document step verifies them.
- Live Gemini behaviour (model id, `thinkingLevel` field) could not be exercised without an API key;
  the provider retries without `thinkingConfig` if it is rejected, and every path falls back to the
  deterministic draft.
- The RLS/scoped-role cutover (`docs/PILOT-READINESS-REPORT.md` §6) is unchanged: the API/worker's
  actual runtime `DATABASE_URL` is still the Postgres superuser, in local dev, CI, and as currently
  documented for production — not the least-privilege `ai_concierge_api`/`ai_concierge_worker`
  roles. Those roles' grants (including the one §9 adds for `outbound_messages`) and the RLS
  policies they're subject to are real and proven in isolation (`rowLevelSecurity.security.test.ts`
  connects _as_ the scoped role against real Postgres), but nothing in this phase changes that the
  application itself does not yet connect through them.

## 9. Addendum (2026-09-27) — bug fixes, e2e, independent review, email retry/resend

This addendum closes the two gaps §8 used to list ("not frozen") and adds one feature that was
originally scoped out. All work below was re-verified against the full gate pipeline before this
phase was marked FROZEN.

**Two conversation-engine bugs, root-caused from a customer-reported failure report (not guessed):**

1. `VehicleIntentService.propose()` evaluated every match tier (exact/brand/category/fuzzy) against
   the *whole* accumulated transcript and returned the first tier with any hit anywhere in it, so an
   early higher-tier mention (a bare "Lamborghini") permanently shadowed a later message that only
   qualified for a lower tier (a lowercase, typo'd "car model ranger rover") — a customer's own
   correction was silently ignored in favour of their first message. Fixed by scanning the
   transcript one message at a time from most recent backward, and by extending fuzzy matching to
   cue-based lowercase phrases ("model X", "want X") alongside capitalized ones.
   `buildAccumulatedTranscript` (`apps/api/src/lib/conversationTranscript.ts`) now collapses any
   newline a customer typed inside one message before joining, so the per-message scan can rely on
   `"\n"` always meaning a message boundary, never text the customer typed.
2. `extractNationality`'s licence-phrase-stripping regex used `\s` (matches newlines), so a
   nationality answered on its own line immediately before a line starting with a licence label
   ("Nationality: Indian\nDriving licence: ...") had the answer silently erased before nationality
   lookup ever ran — this is what produced an observed "keeps asking for nationality after it was
   already given" loop. Fixed to horizontal whitespace only (`[ \t]`), applied the same fix to
   `detectLicenseType`'s equivalent tier patterns (UAE/GCC/IDP/foreign/`NO_LICENSE`/`PASSPORT_YES`/
   `PASSPORT_NO`), and made the licence-type fallback check every word of a match instead of
   assuming the country name is always the last one.

Both are covered by regression tests (`vehicleIntentService.test.ts`'s "cross-message correction"
block, `conversationTranscript.test.ts`, `intakeExtractor.test.ts`).

**Playwright e2e** (`apps/web/e2e/dashboard.spec.ts`, permanent): drives the real signed WhatsApp
webhook end to end and verifies the admin dashboard renders the result — a quote-issued journey's
timeline, and an escalation-queue entry.

**Two independent code-review passes** (via the repo's `/code-review` skill, run cold — no
foreknowledge of what to look for): the first, on the two bug fixes above, caught that my first
patch assumed one-message-per-transcript-line without `buildAccumulatedTranscript` actually
guaranteeing it (fixed, see bug 1 above) and that a test I had written violated `propose()`'s own
precondition (removed, precondition documented instead). The second, on the email-resend feature
below, found three real bugs before it shipped — see below.

**Email retry/resend** (`apps/api/src/services/emailResendService.ts`,
`apps/worker/src/jobs/emailResendSweep.ts`): a Mailgun send that failed used to be dropped entirely
— nothing persisted, nothing to retry, the customer never got a reply. `OutboundMessage` gains
`status` (SENT/FAILED), `deliveryError`, `retryCount`, `subject` and `claimedAt`; a failed send
(automatic reply or staff reply) is now persisted as FAILED instead of discarded. The worker's
`emailResendSweep` periodically retries FAILED email messages (bounded by age and attempt count,
same housekeeping pattern as the hold-expiration/escalation-SLA sweeps); a staff member can also
resend on demand (`POST /v1/enquiries/:conversationId/outbound-messages/:id/resend`), surfaced in
the dashboard's conversation thread as a "Resend" action on a failed message.

The second code-review pass, before this landed, found and fixed three real bugs: (1) the resend
lookup was scoped only by `tenantId`+`id`, not `conversationId`, so a mismatched
conversationId/outboundMessageId pair could resend one customer's private message content to a
*different* customer — fixed by making `findOutboundMessageById` require and enforce
`conversationId` in the query itself; (2) the original email subject was never preserved, so a
resend broke the customer's mail thread with a generic fallback subject — fixed with the stored
`subject` column; (3) the automatic sweep and a staff-triggered resend had no concurrency guard and
could both send the same message at once — fixed via an atomic claim (`claimedAt`, conditional
`updateMany`, the same pattern `AvailabilityHold` already used) that only one caller can win. Each
fix has its own regression test, including a genuine concurrent-HTTP-request race test
(`apps/api/src/emailResend.integration.test.ts`) expecting exactly one 200 and one 409, and exactly
one email sent.

**This phase's own architecture-review pass** (re-reading the feature against the project's
tenant-isolation/least-privilege/audit non-negotiables once everything else was green) found one
further gap: the migrations adding the columns the resend sweep depends on never granted
`ai_concierge_worker` access to `outbound_messages`, unlike the sibling `escalation_cases` migration
which granted that role when the SLA sweep started touching it. Dormant today only because of the
pre-existing, separately-tracked superuser-connection limitation noted in §8 — but a real gap
against this project's own "narrow, explicit, never-auto-granted worker posture" convention. Fixed
in `20260927140000_grant_worker_outbound_message_access` (`GRANT SELECT, UPDATE ON
"outbound_messages" TO ai_concierge_worker;`), matching exactly what the sweep needs and nothing
more.

**Manual verification**: a temporary Playwright script (never committed) drove the real dev stack
in a browser and screenshotted every dashboard screen plus the Resend button/flow. Confirmed: the
Resend button appears on a FAILED email message and, since this sandbox has no real Mailgun
credentials, correctly reports "still could not reach the customer" rather than a faked success (a
positive proof of the "never fake success" principle, not a defect) — the message row's `status`
stays `FAILED`, unchanged. Escalations, Journeys, Customers, Quotes, Audit, Security, Fleet and
Settings all render real, non-placeholder data end to end.

**Final gate results** (2026-09-27, full repo, real Postgres 16 + Redis, no Docker daemon in this
sandbox — same documented limitation as every prior phase): typecheck, lint, unit (all packages),
integration (47 test files across `apps/api`/`apps/worker`/`packages/db`), security (14 files/97
tests), e2e (12/12 Playwright tests including both new `dashboard.spec.ts` cases), production build
(api/worker/web) all green. A fresh `knip` dead-code pass found nothing genuinely unused — every
flagged item (four files, a runtime-only dependency, an ESLint shorthand-resolved devDependency,
nine "exported but not imported elsewhere" bindings, one intentional schema alias) was individually
verified against its actual call site or config reference and is live, used code, not dead code —
consistent with the phase 1-9/16 dead-code audit already completed earlier in this phase's work.
