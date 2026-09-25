# Security Model

Phase 6's threat model, what each layer of `MASTER-PLAN.md` §6's zero-trust diagram actually is in
this codebase today, and the runbooks an operator needs. Read alongside `docs/PHASE-6.md` (what was
built and why) and `docs/phases/PHASE-TEMPLATE.md`'s security checklist.

```
Internet → WAF/Rate Limit → API Gateway → Authentication → Authorization → Tenant Isolation
        → Domain Service → (AI Sandbox → Tool Permission → Egress Allowlist) → Database Policy → Encrypted Data
```

## 1. STRIDE

| Threat                     | Where it applies                                        | Mitigation                                                                                                                                                                                                 | Status                                                                                     |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **S**poofing               | A caller claiming to be someone else                    | argon2id password hashing + short-lived (≤15 min) HS256 access tokens + rotating opaque refresh tokens (`packages/security/src/authn`); HMAC-signed webhooks (Phase 1/5)                                   | Implemented                                                                                |
| **T**ampering              | Request/response/token modified in transit or at rest   | TLS at the edge (Render-terminated); JWT signature verification (`verifyAccessToken`); refresh tokens stored only as a SHA-256 hash, never the raw value; field-level AES-256-GCM for the MFA secret       | Implemented (field encryption scoped to what exists today — see §3)                        |
| **R**epudiation            | "I never did that" after a mutation                     | `AuditEvent` on every mutation (login, refresh, logout, lock/unlock, MFA enroll/verify — see `authService.ts`), same transaction as the mutation itself, append-only, queryable via `GET /v1/audit-events` | Implemented                                                                                |
| **I**nformation disclosure | Seeing data you shouldn't                               | Postgres RLS (tenant isolation, §2), RBAC+ABAC (§2), structured errors that never leak internals/stack traces, output DLP tripwire (§4)                                                                    | Implemented for what exists; passport/licence-number field encryption is future scope (§3) |
| **D**enial of service      | Exhausting a shared resource                            | Redis-backed `@fastify/rate-limit` (shared across instances), a stricter dedicated limit on `/v1/auth/*`, request body size limit, per-account lockout after repeated failed logins                        | Implemented                                                                                |
| **E**levation of privilege | A low-privilege session reaching high-privilege actions | RBAC role→permission matrix + ABAC tenant-match (`authorize()`), enforced as Fastify preHandlers, least-privilege DB roles with no DELETE/DDL/BYPASSRLS                                                    | Implemented                                                                                |

## 2. Zero-trust layers, concretely

| Diagram layer                                   | This codebase                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WAF / Rate Limit                                | `apps/api/src/lib/waf.ts` (known-scanner user-agent denylist) + Redis-backed `@fastify/rate-limit`, both registered in `plugins/security.ts`; `/v1/auth/*` gets its own stricter limit |
| API Gateway                                     | Fastify + Zod schema validation on every route, helmet (CSP/HSTS/etc.), CORS allowlist (unchanged from Phase 1)                                                                        |
| Authentication                                  | `packages/security/src/authn` (real, local) + `IdentityProvider` OIDC seam (not yet backed by a chosen provider — see §3)                                                              |
| Authorization                                   | `packages/security/src/authz/policy.ts` (`authorize()`), applied via `apps/api/src/lib/authz.ts`'s `requirePermission()` preHandler                                                    |
| Tenant Isolation                                | Postgres RLS, `ENABLE`+`FORCE ROW LEVEL SECURITY` on every tenant-scoped table, keyed on the `app.tenant_id` session setting `withTenantContext()` sets per-transaction                |
| Domain Service                                  | `packages/domain` + repositories — unchanged from Phases 1-5                                                                                                                           |
| AI Sandbox / Tool Permission / Egress Allowlist | `packages/ai/src/sandbox/toolPermissionMatrix.ts` (seam — no real tool-calling loop exists yet, see §3) / `ssrfSafeFetch` + `OUTBOUND_ALLOWED_HOSTS` (Phase 1, unchanged)              |
| Database Policy                                 | The least-privilege `ai_concierge_api` / `ai_concierge_worker` roles the `..._add_security_engine` migration creates (not BYPASSRLS, no DELETE/DDL)                                    |
| Encrypted Data                                  | AES-256-GCM (`packages/security/src/crypto.ts`) for the MFA secret at rest; TLS in transit (platform-terminated)                                                                       |

### RBAC role → permission matrix

Roles mirror `MASTER-PLAN.md` §4's escalation tiers (ADMIN is a superset; T1/AI is never a human
role). Full matrix and the "ADMIN is always a superset" invariant are tested in
`packages/security/src/authz/policy.test.ts`.

| Role      | Tier | `audit_event:read` | `security_event:read` | `security_event:respond` | `user:read` | `user:lock` / `user:unlock` |
| --------- | ---- | :----------------: | :-------------------: | :----------------------: | :---------: | :-------------------------: |
| ADMIN     | —    |         ✓          |           ✓           |            ✓             |      ✓      |              ✓              |
| SECURITY  | T4   |         ✓          |           ✓           |            ✓             |      ✓      |              ✓              |
| MANAGER   | T3   |         ✓          |           ✓           |            —             |      ✓      |              —              |
| OPS_AGENT | T2   |         —          |           —           |            —             |      ✓      |              —              |

The ABAC half (`authorize()`) checks tenant match unconditionally, before RBAC — a role can never be
granted enough permission to see across tenants.

## 3. Deliberate scope decisions (documented, not silent)

Per the Phase Execution Protocol's "never fake functionality" rule, everything above is real and
tested against real Postgres/Redis. What's _not_ built yet is listed here explicitly rather than
implied:

- **Local email+password+TOTP is the real AuthN implementation; OIDC federation is a seam.**
  `MASTER-PLAN.md` §3 names OIDC/OAuth2 as the target, but §9 never picked a concrete provider.
  `IdentityProvider` + `NotConfiguredIdentityProvider` (`packages/security/src/authn/identityProvider.ts`)
  exist for when one is — same pattern as `AIProvider`/`WhatsAppClient` before their first adapter.
- **The API/worker's default `DATABASE_URL` is still the Postgres superuser**, in local dev, CI, and
  as currently documented for production — not the least-privilege `ai_concierge_api`/
  `ai_concierge_worker` roles the migration creates. Those roles, their grants, and the RLS policies
  they're subject to are all real and proven (`rowLevelSecurity.security.test.ts` connects _as_ the
  scoped role against real Postgres), but switching the application's own runtime connection to them
  — across every environment, including retrofitting the existing Phase 1-5 test suite's setup/
  teardown helpers, which currently assume superuser access for seeding/truncating — is a global,
  high-blast-radius cutover deserving its own careful pass, not something to rush inside an already
  large phase. **Before that cutover**, re-verify `refresh_tokens`/`idempotency_keys` specifically
  (migration `..._fix_bearer_token_rls_policies` already handles their secret-keyed-lookup RLS
  interaction — see that migration's own comment).
- **AI sandbox tool permission matrix has nothing real to gate yet.** No `AIProvider` adapter
  performs LLM tool-calling — Steps 1-4 all run on deterministic/rule-based engines. The seam
  (`packages/ai/src/sandbox/toolPermissionMatrix.ts`) is built and tested so the first real
  tool-calling loop inherits a working policy check on day one.
- **Output DLP is a tripwire, not an active control today.** Every customer-facing reply this system
  sends is built from Step 4's fixed templates (field _names_ only, never customer data), so
  `flagUnexpectedPiiInOutboundText` should never fire in production right now. It exists so the day a
  future phase adds real free-text AI generation to a reply, that path inherits a working guardrail
  instead of one bolted on after an incident.
- **Field-level encryption is applied to the one real secret this phase introduces** (the MFA TOTP
  seed). Passport/licence-number encryption (`MASTER-PLAN.md` §6) reuses the same primitive
  (`packages/security/src/crypto.ts`) once the document pipeline that stores those numbers exists —
  there is no such column anywhere in the schema yet.
- **Trivy image scanning and OWASP ZAP baseline are not wired into CI.** Both need something that
  doesn't exist yet: Trivy scans a container image, and this repo has no `Dockerfile`
  (`docker-compose.yml` runs Postgres/Redis from public images; the app itself has never been
  containerized); ZAP baseline scans a running, deployed instance, and there is no ephemeral
  CI-deployed environment. Both are natural `Phase 10 — Infrastructure, CI/CD & Release` deliverables
  (which explicitly owns Docker images and staging environments), not something to fabricate here
  just to have a scanner target. `pnpm audit`, gitleaks, and Semgrep (`security.yml`) are already
  wired and unaffected by this.

## 4. Detection & response

`SecurityEvent` (`GET /v1/security-events`, `ADMIN`/`SECURITY` only) is the event stream and today's
T4 escalation surface, until a full `EscalationCase` model exists (Event/Workflow Engine, still
unbuilt). Rules implemented, each with a test:

| Signal                                       | Trigger                                                                                                                                             | Automatic response                                                                                                                                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-account lockout                          | 5 failed logins for one account                                                                                                                     | Account locked 15 minutes (`ACCOUNT_LOCKED`, CRITICAL)                                                                                                                                                                                 |
| `ANOMALY_LOGIN_VELOCITY`                     | 20+ failed logins tenant-wide within 5 minutes (any accounts)                                                                                       | Flagged CRITICAL for operator review (credential-stuffing signal)                                                                                                                                                                      |
| `TOKEN_REUSE_DETECTED`                       | A refresh token is presented after it was already rotated out — including two genuinely concurrent presentations of the same still-valid token (§5) | The entire session family is revoked immediately: refresh tokens in Postgres, and live access tokens via a Redis revocation set keyed by family id (closes the ≤15 min residual-JWT-validity window a DB-only revoke would leave open) |
| `ANOMALY_MASS_EXPORT`                        | One actor makes 30+ audit/security-event list requests within 5 minutes                                                                             | Flagged WARNING for operator review                                                                                                                                                                                                    |
| `PERMISSION_DENIED` / `CROSS_TENANT_ATTEMPT` | Any AuthZ denial                                                                                                                                    | Recorded (not just rejected) — visible to a SECURITY operator                                                                                                                                                                          |
| `DLP_OUTBOUND_PII_DETECTED`                  | Outbound customer-facing text matches a PII pattern                                                                                                 | Flagged WARNING, send proceeds (§3 — should never fire today)                                                                                                                                                                          |

Manual response: `POST /v1/users/:id/lock` / `.../unlock` (`SECURITY_EVENT_RESPOND`/`USER_LOCK` /
`USER_UNLOCK` permission) — locking revokes every session the account holds, immediately, the same
way reuse-detection does.

## 5. Compromised-account kill chain

`apps/api/src/killChain.security.test.ts` proves containment end to end, over the real HTTP API and
real Postgres, for three scenarios:

1. A stolen low-privilege (`OPS_AGENT`) session reaching for admin-only endpoints — stopped at AuthZ.
2. A stolen `ADMIN` session (the strongest role) attempting to read another tenant's data — stopped
   at tenant isolation (RLS), proven by cross-referencing the API response against the database
   directly, not just trusting the response shape.
3. A stolen refresh token, replayed after the legitimate user already rotated it (including the
   genuinely-concurrent case, §4) — stopped by reuse detection, which kills the _entire_ session
   (the legitimate user's still-valid access token included), then a SECURITY operator locks the
   account outright.

`packages/db/src/repositories/rowLevelSecurity.security.test.ts` proves the tenant-isolation layer in
isolation (connected _as_ the scoped, non-superuser role); `packages/security/src/authz/policy.test.ts`
proves the full RBAC×permission matrix.

## 6. Key rotation runbook

| Secret                                                                        | Where                                                                              | Rotation                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SIGNING_SECRET`                                                          | Render env var, `generateValue: true`                                              | Rotating it invalidates every live access token instantly (all callers get `401` and must refresh) but not refresh tokens, which aren't signed by it. Safe to rotate any time; expect a brief wave of re-authentications.                                                                                                                                                                                                                                                          |
| `MFA_ENCRYPTION_KEY`                                                          | Render env var, operator-supplied (§ render.yaml)                                  | Rotating it makes every _already-enrolled_ user's stored `mfaSecretCiphertext` undecryptable. Do not rotate without a migration step that re-encrypts existing rows under the new key first (decrypt-with-old, encrypt-with-new, in one transaction per row) — otherwise every MFA-enrolled user is locked out of their second factor. No such migration exists yet because no production deployment has enrolled a real user yet; write it before this key's first real rotation. |
| `WEBHOOK_SIGNING_SECRET`                                                      | Render env var, `generateValue: true`                                              | Unchanged from Phase 1 — placeholder only, replaced per-channel (e.g. `WHATSAPP_APP_SECRET`, which Meta issues and rotates on their side).                                                                                                                                                                                                                                                                                                                                         |
| Least-privilege DB role passwords (`ai_concierge_api`, `ai_concierge_worker`) | `ALTER ROLE ... PASSWORD` in the target database, matching migration's placeholder | `change-me-in-production` (migration `..._add_security_engine`) must be rotated before any non-local deployment that actually connects as these roles — see §3's note that today's default connection doesn't yet.                                                                                                                                                                                                                                                                 |
| Refresh tokens (per-user)                                                     | `refresh_tokens` table                                                             | Self-rotating on every use by design (§4); an operator can force-revoke all of a user's sessions immediately via `POST /v1/users/:id/lock`.                                                                                                                                                                                                                                                                                                                                        |

## 7. What Phase 7+ needs from this phase

- **Phase 7 (Admin Dashboard)**: `GET /v1/audit-events` and `GET /v1/security-events` are the read
  paths for the Audit log and Escalation queue screens; `AuthContext`/`authorize()` are ready for
  route-level and component-level guards.
- **Phase 8 (Customer PWA)**: customer-facing auth (distinct from this phase's _staff_ auth) is not
  built — customers are still identified only by `customerRef` on `Conversation`, unchanged.
- **Phase 10 (Infra)**: the DB-role cutover (§3), Trivy/ZAP wiring (§3), and the MFA key rotation
  migration (§6) are the concrete carry-overs.
