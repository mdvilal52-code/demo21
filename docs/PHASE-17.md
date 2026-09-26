# Phase 17 — Frontend completion: admin dashboard, human worker, customer web chat (PWA)

Scope: make the deployed website (Vercel) actually expose the backend that already ran
Steps 1–8 — for staff (admin dashboard, human-worker reply) and for customers (a chat app).

## Backend additions (apps/api, packages/db, packages/contracts, packages/domain)

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /v1/dashboard/summary` | staff (`journey:read`) | journey counts per state, escalations, quotes, % handled automatically |
| `GET /v1/quotes` | staff | latest version of every quote |
| `GET /v1/conversations/:id/transcript` | staff | full transcript incl. automatic vs human vs customer authorship |
| `POST /v1/conversations/:id/reply` | `conversation:reply` | human worker replies; WEB → stored (shown in the customer's chat), WHATSAPP/EMAIL → sent through the configured provider, recorded only if actually delivered; audit event without message text; 409 for terminal journeys |
| `POST /v1/chat/messages`, `GET /v1/chat/sessions/:id` | public, rate-limited | customer web chat: same Steps 1–8 engine, idempotent by `clientMessageId`, per-session and global Redis limits |

- Migration `20260926180000_add_outbound_message_author` adds `outbound_messages.authorUserId`
  (who wrote a human reply). New permission `conversation:reply`.
- Money is displayed without decimals for whole amounts and with two otherwise (`AED 14,752.50`).
- Web chat never exposes the quote integrity hash; the customer sees a quote only from the issued
  quote record, never AI-authored numbers (grounding guard unchanged).

## Frontend additions (apps/web)

- Staff (`/dashboard/*`, role-aware navigation): overview with journey stepper and stat tiles,
  journeys list + detail with transcript, quote panel and human reply form, escalations, quotes,
  audit log, security events. Auto-refresh by polling (no SSE).
- Customer PWA (`/concierge/*`): home, chat (progress bar, quote card, "Confirm with our team"),
  requests, profile; web manifest, icons, service worker (scope `/concierge`, `/api/*` never
  cached, offline page precached **with** its build assets), install prompt.
- Chat turns can take a while (Steps 1–8 + Gemini), so the relay allows 50 s and the client
  retries the same `clientMessageId` (409/502/503/504) before showing "Tap to retry".

## Not built (needs providers/backend work that does not exist — deliberately not faked)

Bookings, document upload/review, payments/invoices, Steps 9–19, push notifications, server-sent
events. The UI states "not available yet" instead of pretending.

## Verification

Unit tests (all packages), API integration + security tests against a real Postgres/Redis, and
Playwright-driven browser flows (admin: 27 checks; customer PWA on a phone viewport: home,
manifest, service worker, chat → driver details → quote → hand-over, staff reply appearing
without reload, offline page). Known noise: a DLP *warning* can fire on replies containing
amounts (digits resemble phone numbers) — log only, nothing blocked.
