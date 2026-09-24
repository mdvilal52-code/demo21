-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'OPS_AGENT', 'SECURITY');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILURE', 'MFA_ENROLLED', 'MFA_FAILURE', 'TOKEN_REUSE_DETECTED', 'ACCOUNT_LOCKED', 'PERMISSION_DENIED', 'CROSS_TENANT_ATTEMPT', 'SESSION_REVOKED', 'ANOMALY_LOGIN_VELOCITY', 'ANOMALY_MASS_EXPORT');

-- CreateEnum
CREATE TYPE "SecuritySeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecretCiphertext" TEXT,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedByTokenId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "type" "SecurityEventType" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_tenantId_idx" ON "users"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_tenantId_idx" ON "refresh_tokens"("tenantId");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "security_events_tenantId_idx" ON "security_events"("tenantId");

-- CreateIndex
CREATE INDEX "security_events_tenantId_severity_idx" ON "security_events"("tenantId", "severity");

-- CreateIndex
CREATE INDEX "security_events_userId_idx" ON "security_events"("userId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Phase 6 — Tenant isolation: Row Level Security (enforced backstop below the
-- application-level `WHERE tenantId = …` filtering every repository already
-- does). Policies key off the `app.tenant_id` session setting, which
-- `withTenantContext()` (@ai-concierge/security) sets per-transaction via
-- `SELECT set_config('app.tenant_id', $1, true)`. `current_setting(..., true)`
-- returns NULL when unset (e.g. a raw psql session, or code that forgot to
-- call withTenantContext) — comparing a column to NULL is never true, so
-- access fails closed by default, not open.
-- ============================================================================

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenants"
  USING ("id" = current_setting('app.tenant_id', true))
  WITH CHECK ("id" = current_setting('app.tenant_id', true));

ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "conversations"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- `messages` carries no direct tenantId column — isolation follows its parent
-- conversation. A subquery (not an index-friendly equality filter) is the
-- correct tradeoff at this table's scale; revisit only if profiling shows
-- otherwise.
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "messages"
  USING (EXISTS (
    SELECT 1 FROM "conversations" c
    WHERE c."id" = "messages"."conversationId"
      AND c."tenantId" = current_setting('app.tenant_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "conversations" c
    WHERE c."id" = "messages"."conversationId"
      AND c."tenantId" = current_setting('app.tenant_id', true)
  ));

ALTER TABLE "intent_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intent_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "intent_records"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_events"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "idempotency_keys"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "date_location_extractions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "date_location_extractions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "date_location_extractions"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "vehicles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vehicles"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "vehicle_determinations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_determinations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vehicle_determinations"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "missing_info_checks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "missing_info_checks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "missing_info_checks"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "users"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "refresh_tokens"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "security_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "security_events"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- ============================================================================
-- Least-privilege DB roles (MASTER-PLAN.md §6: "separate DB roles: api,
-- worker, migrator"). Roles are cluster-wide objects (not per-database), so
-- this must be idempotent across every database in the cluster this
-- migration runs against (e.g. the dev and *_test databases sharing one
-- local Postgres instance).
--
-- Passwords are placeholders, exactly like `.env.example`'s
-- WEBHOOK_SIGNING_SECRET="change-me-in-production" convention — rotate
-- before any real deployment; see docs/SECURITY-MODEL.md's key rotation
-- runbook. Neither role has BYPASSRLS, so the policies above apply to them
-- unconditionally — only a superuser/table-owner connection (migrations)
-- can see across tenants.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_concierge_api') THEN
    CREATE ROLE ai_concierge_api LOGIN PASSWORD 'change-me-in-production'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_concierge_worker') THEN
    CREATE ROLE ai_concierge_worker LOGIN PASSWORD 'change-me-in-production'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ai_concierge_api, ai_concierge_worker;

-- API: everything the /v1 surface + auth reads or writes. No DELETE, no
-- TRUNCATE, no DDL — matches AuditEvent's own "append-only" contract and
-- means a compromised API credential can neither erase history nor drop data.
GRANT SELECT, INSERT, UPDATE ON
  "tenants", "conversations", "messages", "intent_records", "audit_events",
  "idempotency_keys", "date_location_extractions", "vehicles",
  "vehicle_determinations", "missing_info_checks", "users", "refresh_tokens",
  "security_events"
TO ai_concierge_api;

-- Worker: narrower still — only what apps/worker's processors touch today
-- (postEnquiryProcessor reads/updates a conversation and writes an audit
-- event; see apps/worker/src/processors/postEnquiryProcessor.ts).
GRANT SELECT ON "tenants", "messages" TO ai_concierge_worker;
GRANT SELECT, UPDATE ON "conversations" TO ai_concierge_worker;
GRANT SELECT, INSERT ON "audit_events", "security_events" TO ai_concierge_worker;
GRANT SELECT, INSERT, UPDATE ON "idempotency_keys" TO ai_concierge_worker;

-- Future tables created by whichever role runs migrations (this migration
-- runs as the cluster superuser in this project's setup) are granted to the
-- api role automatically, so ordinary future migrations don't need to repeat
-- this GRANT boilerplate. The worker's narrower grant stays explicit
-- per-table on purpose — its access should never grow silently.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO ai_concierge_api;
