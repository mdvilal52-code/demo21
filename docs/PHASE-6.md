# Phase 6 — Security Engine & Zero Trust

Status: **FROZEN**

## 1. Pre-flight

- Read `docs/PHASE-EXECUTION-PROTOCOL.md`, `docs/PHASE-CONTRACTS.json`, `docs/MASTER-PLAN.md`. No UI
  changes this phase (backend/data-model only), so `docs/DESIGN-SYSTEM.md` has nothing to apply.
- Read `docs/PHASE-5.md` (previous phase) and its §13 forward contract — Phase 6 (this phase) was one
  of two open pieces it named; journey Step 5 (Eligibility) and the rest of the original phase-5
  grouping (documents, payments, CRM, Web-chat/Email channels) remain unbuilt and unnumbered, same as
  before.
- Inspected the repository: there was **no authentication or authorization of any kind** before this
  phase — every existing endpoint is intentionally-public customer-journey intake (a customer
  submitting an enquiry never logs in), and `DEFAULT_TENANT_ID` is a single hardcoded tenant used
  everywhere. No `User`, no admin CRUD, no Event/Workflow Engine, no `EscalationCase` — the codebase
  is materially earlier-stage relative to `MASTER-PLAN.md`'s full architecture than its phase number
  suggests. Existing security primitives already present and reused, not rebuilt: `packages/security`
  (CORS, secure headers, `ssrfSafeFetch` + egress allowlist, generic HMAC webhook signing, CSRF,
  resilience primitives), `packages/ai`'s prompt-injection sanitizer, `packages/domain`'s
  `classifyPII`/`redactPII`, `AuditEvent` (written since Phase 1, never previously readable via the
  API), `IdempotencyKey`.
- Installed PostgreSQL 16 and started Redis locally in this sandbox (no Docker daemon here, same
  documented limitation as every prior phase) and ran the existing suite as a baseline before changing
  anything: typecheck/lint/format all green; 325 unit, 69 integration, 48 security, 4 e2e — matching
  `docs/PHASE-5.md` §8 exactly.

## 2. Scope

Goal: the security architecture from `MASTER-PLAN.md`'s zero-trust diagram, verified by tests — see
`docs/SECURITY-MODEL.md` for the full threat model, the layer-by-layer mapping, and which parts of the
original Phase 6 deliverable list are real today versus documented, scoped-out seams (OIDC
federation, the DB-role connection cutover, AI tool-calling sandbox enforcement, Trivy/ZAP). Concretely
built this phase:

- **AuthN**: real, working local email+password+TOTP-MFA staff authentication — argon2id, short-lived
  JWT access tokens, rotating refresh tokens with reuse detection, encrypted-at-rest MFA secrets.
- **AuthZ**: RBAC role→permission matrix + ABAC tenant-match policy engine, enforced as Fastify
  preHandlers.
- **Tenant isolation**: Postgres Row Level Security on every tenant-scoped table (new and pre-existing
  — this phase retrofits Phases 1-5's tables too), backed by real least-privilege DB roles.
- **Edge/WAF**: Redis-backed rate limiting (was in-memory), a stricter limit on `/v1/auth/*`, a known-
  scanner-user-agent denylist.
- **Detection & response**: an append-only `SecurityEvent` stream, five anomaly/detection rules, and
  both automatic (session revocation) and manual (`lock`/`unlock`) restricted response.
- **AI sandbox / output DLP**: seams — see `docs/SECURITY-MODEL.md` §3 for why there's nothing real to
  gate yet.
- Two new admin-authenticated read endpoints (`GET /v1/audit-events`, `GET /v1/security-events`) —
  the first pieces of Phase 7's Audit log / Escalation queue screens' read paths, built ahead of that
  UI existing, same precedent as Phase 5's `WhatsAppClient` seam.

## 3. Design decisions

- **Local auth is the real implementation; OIDC is a seam, not a stub.** `MASTER-PLAN.md` §3 names
  OIDC/OAuth2, but §9 never chose a provider. Rather than either hand-rolling a full OIDC identity
  _server_ (large, security-sensitive, and unnecessary scope) or blocking on a provider decision, this
  phase built a fully real, working, tested local AuthN system and an `IdentityProvider` seam +
  `NotConfiguredIdentityProvider` default — exactly the `AIProvider`/`WhatsAppClient` pattern already
  established: the interface exists now so a later phase writes an adapter instead of inventing the
  seam under deadline pressure.
- **Failure paths that must persist state cannot throw from inside the same `withTenantContext`
  transaction that records them.** Caught by the phase's own test suite (the lockout test failed on
  first run): Prisma's interactive `$transaction` rolls back every write in it when the callback
  throws. `login()`'s wrong-password path needs its `recordLoginFailure`/`recordSecurityEvent` writes
  to survive even though the overall attempt fails — so it returns a discriminated result and the
  caller throws once, after the transaction has already committed. `refresh()`'s race-lost path is the
  mirror image: there, the throw-and-roll-back is _exactly_ what's wanted, to discard the orphaned
  replacement token — see the `RefreshRaceLostError` comment in `authService.ts`.
- **Refresh-token rotation is race-safe, not just sequentially reuse-safe.** A first pass (caught by
  `/code-review --level high` before this phase was called done, not after) detected reuse only when
  a token was already marked `revokedAt` _at lookup time_ — two genuinely concurrent refreshes of the
  same token could both pass that check and both mint a pair. Fixed with a conditional revoke
  (`revokeRefreshTokenIfActive`, `UPDATE ... WHERE revokedAt IS NULL`): Postgres's row locking makes
  the loser's write observably fail, and losing the race is treated exactly like sequential reuse
  (whole family killed). Proven with a test that fires two real simultaneous refresh calls.
- **The blanket RLS policy is wrong for exactly two tables.** `refresh_tokens` and `idempotency_keys`
  are looked up by an opaque secret alone (`findRefreshTokenByHash`, `findIdempotencyKey`), before any
  tenant is known — there is nothing to set `app.tenant_id` to yet. Under the original blanket
  tenant-scoped policy this only worked because today's runtime connection is the Postgres superuser
  (RLS-exempt); the moment that connection is cut over to the least-privilege role (the documented
  next step), every refresh/logout/idempotency lookup would have silently started returning zero rows.
  A follow-up migration (`..._fix_bearer_token_rls_policies`) replaces the policy for just these two
  tables: SELECT unconditional (the secret is the real access control for a bearer-token lookup),
  INSERT/UPDATE still tenant-scoped.
- **Login timing must not leak account existence either.** The response body for "unknown email" and
  "wrong password" is identical by design, but only the wrong-password path used to pay argon2's real
  hashing cost — a timing measurement alone could still distinguish them. Fixed by verifying against a
  fixed, non-secret dummy hash (`DUMMY_PASSWORD_HASH`) on the unknown-email path too.
- **MFA re-enrollment is refused, not silently overwritten.** Calling enroll a second time on an
  already-enrolled account used to replace the stored secret with no re-verification — the user's
  authenticator app would keep producing codes for the old secret while the server checked the new
  one, a self-inflicted, permanent-until-operator-intervention lockout. There is no "disable MFA" flow
  yet for a user to have legitimately triggered a re-enroll, so it now refuses with `CONFLICT`.
- **Session revocation is immediate, not eventually-consistent with token expiry.** A JWT access token
  is self-contained and valid until its own `exp`; revoking only the refresh-token row would leave an
  already-issued access token usable for up to 15 more minutes. `apps/api/src/lib/sessionRevocation.ts`
  adds a Redis set keyed by refresh-token family id, checked on every authenticated request
  (`plugins/auth.ts`), with a TTL matching the access-token lifetime (nothing older could still be
  valid anyway, so the set needs no separate cleanup).
- **RBAC permissions are scoped to what's real today, not padded for future screens.** Six
  permissions (`audit_event:read`, `security_event:read`, `security_event:respond`, `user:read`,
  `user:lock`, `user:unlock`) — no `booking:*`/`pricing:*`/etc., since none of those resources exist
  yet. `docs/SECURITY-MODEL.md` §2 has the full role×permission matrix.
- **No new packages.** AuthN/AuthZ landed inside the existing `packages/security` (matching
  `MASTER-PLAN.md` §1's responsibility table), the new domain types inside `packages/domain`, the
  sandbox seam inside `packages/ai` — all extending established packages rather than fragmenting the
  workspace, same judgment call Phase 5 made about `packages/channels`.
- **AuthN had to be split out of `packages/security`'s main barrel export**, into a
  `@ai-concierge/security/authn` subpath. Caught by actually running the `build` gate, not by
  typecheck/lint: `apps/web` imports `ssrfSafeFetch` from that same barrel for its SSRF-safe proxy
  route, and Next.js's build eagerly evaluates the whole module graph a route touches — a native addon
  anywhere in it (argon2, pulled in by password hashing) broke `next build` even though the web app
  never calls it. The fix keeps the main barrel dependency-light (pure `node:crypto`, no native
  addons) and moves argon2/jose/otplib-backed code to a subpath only `apps/api` imports.

## 4. What was built

**Data model** (`packages/db/prisma/schema.prisma` + two migrations):

- `User` (role, status, MFA fields, lockout counters), `RefreshToken` (rotation family tracking),
  `SecurityEvent` (append-only detection/response stream).
- `..._add_security_engine`: the three tables above; RLS (`ENABLE`+`FORCE ROW LEVEL SECURITY` +
  a `tenant_isolation` policy) on every tenant-scoped table, old and new; `ai_concierge_api` /
  `ai_concierge_worker` least-privilege roles with per-table grants and no DELETE/DDL/BYPASSRLS.
- `..._add_dlp_security_event_type`: one new `SecurityEventType` enum value.
- `..._fix_bearer_token_rls_policies`: replaces the blanket policy on `refresh_tokens`/
  `idempotency_keys` — see §3.

**`packages/security`**: `crypto.ts` (AES-256-GCM field encryption, SHA-256 hashing, opaque token
generation — kept in the main barrel, pure `node:crypto`); `authn/` subpath (`passwords.ts` argon2id,
`accessTokens.ts` jose/HS256 JWT, `refreshTokens.ts` rotation primitives, `totp.ts` otplib MFA,
`identityProvider.ts` the OIDC seam); `authz/policy.ts` (`authorize()`, `isSelf()`).

**`packages/db`**: `tenantContext.ts` (`withTenantContext()` — sets `app.tenant_id` via
`set_config(..., true)` for one transaction); `userRepository.ts`, `refreshTokenRepository.ts`,
`securityEventRepository.ts`; `listAuditEvents` added to the existing `auditRepository.ts`.

**`packages/domain`**: `auth.ts` — `UserRole`/`UserStatus`/`SecurityEventType`/`SecuritySeverity`/
`Permission` enums + schemas, the `ROLE_PERMISSIONS` matrix, `AuthContext`, `accessTokenClaimsSchema`,
`authenticatedUserSchema`.

**`packages/ai`**: `sandbox/toolPermissionMatrix.ts` — the tool-calling permission seam (§ SECURITY-
MODEL.md §3).

**`packages/contracts`**: `auth.ts`, `adminEvents.ts` — request/response Zod schemas for every new
endpoint below.

**`apps/api`**: `plugins/auth.ts` (`authenticate` preHandler), `lib/authz.ts`
(`requirePermission()`), `lib/sessionRevocation.ts` (Redis family-revocation set), `lib/dlp.ts`
(output PII tripwire), `lib/anomalyDetection.ts` (mass-export Redis counter), `lib/waf.ts` (scanner
user-agent denylist), `services/authService.ts` (`login`/`refresh`/`logout`/`getMe`/`enrollMfa`/
`verifyMfaEnrollment`/`setUserLock`/`createStaffUser`), `routes/v1/auth.ts`, `routes/v1/audit.ts`,
`routes/v1/securityEvents.ts`, `routes/v1/users.ts`; Redis-backed `@fastify/rate-limit` wiring in
`plugins/security.ts`; six new required/optional env vars in `env.ts`.

## 5. APIs

| Method | Path                       | Auth                                 | Purpose                                                                 |
| ------ | -------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| POST   | `/v1/auth/login`           | none (stricter rate limit)           | Email+password (+MFA code if enrolled) → access+refresh token pair      |
| POST   | `/v1/auth/refresh`         | valid refresh token                  | Rotates the refresh token, issues a new access token                    |
| POST   | `/v1/auth/logout`          | valid refresh token                  | Revokes one session                                                     |
| GET    | `/v1/auth/me`              | access token                         | The authenticated user's own safe profile                               |
| POST   | `/v1/auth/mfa/enroll`      | access token                         | Generates + stores an encrypted TOTP secret, returns the enrollment URI |
| POST   | `/v1/auth/mfa/verify`      | access token                         | Confirms enrollment with a real code, flips `mfaEnabled`                |
| GET    | `/v1/audit-events`         | access token + `audit_event:read`    | Tenant-scoped, cursor-paginated audit trail                             |
| GET    | `/v1/security-events`      | access token + `security_event:read` | Tenant-scoped, cursor-paginated, filterable by severity                 |
| POST   | `/v1/users/:userId/lock`   | access token + `user:lock`           | Suspends the account, revokes every session immediately                 |
| POST   | `/v1/users/:userId/unlock` | access token + `user:unlock`         | Reactivates the account                                                 |

All ten join the OpenAPI doc at `/docs` (unlike Phase 5's WhatsApp webhook, these are ordinary `/v1`
resources, not an external provider's own contract).

## 6. Database schema

See §4. Four migrations this phase: `add_security_engine`, `add_dlp_security_event_type`,
`fix_bearer_token_rls_policies` (all committed), applied to a completely fresh database as part of
verifying migrations up/down/up — see §9.

## 7. Security decisions

Covered in full in `docs/SECURITY-MODEL.md`. Summary of what's proven, not just asserted:

- RLS is real: `rowLevelSecurity.security.test.ts` connects _as_ the least-privilege
  `ai_concierge_api`/`ai_concierge_worker` roles against real Postgres and proves cross-tenant reads
  return zero rows (even by exact known id, even via a raw query with no `WHERE tenantId`), writes to
  the wrong tenant are rejected, the roles cannot `DELETE`/bypass RLS/create roles, and the
  bearer-secret tables' SELECT-always/write-scoped split works as designed.
- The RBAC×ABAC policy engine's full matrix (every role × every permission) is asserted in
  `policy.test.ts`, including the "ADMIN is always a superset" invariant.
- The compromised-account kill chain (`killChain.security.test.ts`) proves three independent
  containment stories end to end over the real HTTP API: AuthZ containment, tenant-isolation
  containment, and token-theft containment (including the concurrent-refresh race) followed by human
  response.
- No account enumeration: identical response body _and_ now-equalized timing (§3) for unknown-email
  vs. wrong-password.
- No secrets/stack traces in any auth error response; SQL/injection-shaped input handled as inert text
  (`auth.security.test.ts`).
- `/v1/auth/login` and `/v1/auth/refresh` have their own, stricter, independently-testable rate limit.

## 8. Test results

All commands run against real local PostgreSQL 16 + Redis 7 (same sandbox limitation as every prior
phase — no Docker daemon) — genuine HTTP requests through the real Fastify app, real argon2/JWT/TOTP,
real database writes and real Postgres RLS enforcement under a real non-superuser role connection, not
mocks standing in for the boundary being tested.

| Gate        | Command                     | Result                                                                                                                                                                                            |
| ----------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck   | `pnpm typecheck`            | ✅ 11/11 packages                                                                                                                                                                                 |
| Lint        | `pnpm lint`                 | ✅ 0 errors, 0 warnings                                                                                                                                                                           |
| Format      | `pnpm format:check`         | ✅ clean                                                                                                                                                                                          |
| Unit        | `pnpm test:unit`            | ✅ 383 tests (58 new: 61 security-package incl. crypto/authn/authz, minus the pre-existing 3; +6 toolPermissionMatrix in packages/ai)                                                             |
| Integration | `pnpm test:integration`     | ✅ 101 tests (32 new: 18 db repository/tenantContext + 14 apps/api auth flows)                                                                                                                    |
| Security    | `pnpm test:security`        | ✅ 73 tests (27 new: 9→14 db RLS incl. bearer-secret tables, +23 apps/api: auth security + kill chain)                                                                                            |
| E2E         | `pnpm test:e2e`             | ✅ 4 tests, unchanged (no UI touched)                                                                                                                                                             |
| Build       | `pnpm build`                | ✅ every package + Next.js production build (incl. the native-addon-leak fix, §3)                                                                                                                 |
| Code review | `/code-review --level high` | ✅ 6 findings, all fixed and re-verified (refresh-token race, login timing leak, MFA re-enroll lockout, RLS bearer-token landmine, DLP error handling, missing refresh audit event) — see git log |

Full Phase 1-5 regression re-run and green: every pre-existing test still passes unchanged, exactly
matching `docs/PHASE-5.md` §8's baseline counts before this phase's additions.

## 9. Migrations up/down/up

Prisma does not generate down migrations; "up/down/up" for this project means proving every migration
composes cleanly from a genuinely empty database, not just as an incremental add-on to an
already-migrated one. Verified by dropping and recreating a scratch database and running
`prisma migrate deploy` against it from scratch: all migrations (Phases 1-5's four plus this phase's
three) applied cleanly in order.

## 10. Known limitations

- **The DB-role connection cutover is deferred to Phase 10** — see `docs/SECURITY-MODEL.md` §3. RLS
  and the least-privilege roles are real and proven; the application's own default connection string
  hasn't been switched to them yet, everywhere (local dev, CI, and production as currently documented
  in `render.yaml`/`.env.example`).
- **OIDC federation is a seam, not a working integration** — no external identity provider has been
  chosen (`MASTER-PLAN.md` §9 leaves this open). Local email+password+TOTP is the real, fully working
  AuthN path today.
- **AI sandbox / output DLP have nothing real to enforce yet** — no AIProvider adapter performs LLM
  tool-calling, and no reply is generated as free text. Both are tested seams for future phases.
- **No self-service registration or password reset.** Staff accounts are provisioned (`createStaffUser`,
  intended for a seed script or a future admin-only "invite user" endpoint — neither is wired to a
  route yet). Forgotten-password recovery does not exist; today the only recourse for a locked-out
  user is an ADMIN/SECURITY operator using `/v1/users/:id/unlock`, or waiting out the 15-minute
  lockout window.
- **No MFA-disable flow.** An enrolled user cannot remove their own second factor; only re-enrollment
  is blocked (§3) — there's no path to legitimately reset it either yet.
- **Trivy image scanning and OWASP ZAP baseline are not in CI** — no Dockerfile, no deployed ephemeral
  environment exist yet to scan. `pnpm audit`, gitleaks, and Semgrep remain wired in `security.yml`,
  unaffected.
- **No Docker daemon in this dev sandbox** (same as every prior phase) — PostgreSQL 16 and Redis were
  installed and run directly here instead.
- **Journey Step 5 (Eligibility) and the rest of the original phase-5 grouping remain unbuilt** — see
  §1; this phase does not touch either.

## 11. Files created

Data model: `packages/db/prisma/migrations/{20260924135638_add_security_engine,
20260924142004_add_dlp_security_event_type, 20260924145512_fix_bearer_token_rls_policies}/migration.sql`,
`packages/db/src/tenantContext.ts` (+ `.test.ts`), `packages/db/src/repositories/{userRepository,
refreshTokenRepository,securityEventRepository}.ts` (+ `.test.ts`),
`packages/db/src/repositories/rowLevelSecurity.security.test.ts`.

`packages/domain/src/auth.ts`.

`packages/security/src/crypto.ts` (+ `.test.ts`), `packages/security/src/authn/{index,passwords,
accessTokens,refreshTokens,totp,identityProvider}.ts` (+ `.test.ts` where applicable),
`packages/security/src/authz/policy.ts` (+ `.test.ts`).

`packages/ai/src/sandbox/toolPermissionMatrix.ts` (+ `.test.ts`).

`packages/contracts/src/{auth,adminEvents}.ts`.

`apps/api/src/plugins/auth.ts`, `apps/api/src/lib/{authz,sessionRevocation,dlp,anomalyDetection,
waf}.ts`, `apps/api/src/services/authService.ts`, `apps/api/src/routes/v1/{auth,audit,securityEvents,
users}.ts`, `apps/api/src/{auth.integration,auth.security,killChain.security}.test.ts`.

`docs/SECURITY-MODEL.md`, `docs/PHASE-6.md` (this file).

## 12. Files modified

`packages/db/prisma/schema.prisma`, `packages/db/src/{index,repositories/auditRepository}.ts`,
`packages/domain/src/index.ts`, `packages/security/src/index.ts` (AuthN moved to the `/authn`
subpath — §3), `packages/ai/src/index.ts`, `packages/testing/src/db.ts` (`seedTestUser`,
`createScopedRoleTestPrismaClient`, table list), `packages/contracts/src/index.ts`.

`apps/api/src/{app,env,env.test}.ts`, `apps/api/src/plugins/security.ts` (Redis-backed rate limit,
WAF hook), `apps/api/src/services/whatsappService.ts` (DLP wired into the outbound reply path),
`apps/api/src/test/buildTestApp.ts`, `apps/web/playwright.config.ts` (e2e's API webServer needed the
two new required env vars).

`.env.example`, `render.yaml`, `package.json` (`argon2` added to `pnpm.onlyBuiltDependencies`),
`docs/PHASE-CONTRACTS.json`.

No working Phase 1-5 functionality was changed; the full existing test suite re-run and green (§8) is
the proof.

## 13. Next-phase contract (proposed inputs)

Per `PHASE-CONTRACTS.json`, Phase 7 (Admin Dashboard) is next. It can build directly on:

- `GET /v1/audit-events` / `GET /v1/security-events` as the Audit log / Escalation queue screens' read
  paths.
- `authenticate`/`requirePermission` as the pattern for any new admin route.
- `AuthenticatedUser`/`AuthContext` for whatever session/identity the dashboard's own login screen
  needs to drive — `POST /v1/auth/login` and friends are ready to be a real login screen's backend
  today.

Still open, unrelated to Phase 7, carried over unchanged from `docs/PHASE-5.md` §13: journey Step 5
(Eligibility) and the remaining original phase-5 grouping (documents, payments, CRM, delivery/return,
Web-chat/Email channels). Do not start any of these until asked.
