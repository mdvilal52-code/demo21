-- ============================================================================
-- Fixes a landmine in migration `..._add_security_engine`'s blanket
-- tenant_isolation policy: `refresh_tokens` and `idempotency_keys` are both
-- looked up by an opaque, cryptographically unguessable secret alone
-- (findRefreshTokenByHash, findIdempotencyKey) — the caller does not know,
-- and cannot know, which tenant the row belongs to until the lookup itself
-- tells them, so there is nothing to set `app.tenant_id` to beforehand.
-- Under the original blanket policy this works ONLY because today's
-- runtime connection is the Postgres superuser (bypasses RLS entirely); the
-- moment that connection is cut over to the least-privilege `ai_concierge_api`
-- role (the documented next step — see docs/SECURITY-MODEL.md), every such
-- lookup would silently return zero rows forever, since
-- current_setting('app.tenant_id', true) is NULL before the row is found.
--
-- The fix: for these two tables specifically, SELECT is allowed
-- unconditionally (the secret itself, not tenant context, is the real
-- access control for a lookup-by-secret) while INSERT/UPDATE stay
-- tenant-scoped exactly as before (defense in depth: even a compromised
-- `ai_concierge_api` connection authenticated as tenant A cannot write or
-- revoke a row it did not itself just create/verify as tenant A's).
-- ============================================================================

DROP POLICY tenant_isolation ON "refresh_tokens";

CREATE POLICY select_any_by_secret ON "refresh_tokens"
  FOR SELECT
  USING (true);

CREATE POLICY tenant_scoped_insert ON "refresh_tokens"
  FOR INSERT
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY tenant_scoped_update ON "refresh_tokens"
  FOR UPDATE
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY tenant_isolation ON "idempotency_keys";

CREATE POLICY select_any_by_secret ON "idempotency_keys"
  FOR SELECT
  USING (true);

CREATE POLICY tenant_scoped_insert ON "idempotency_keys"
  FOR INSERT
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY tenant_scoped_update ON "idempotency_keys"
  FOR UPDATE
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
