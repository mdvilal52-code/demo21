import type { Prisma, PrismaClient } from '@prisma/client';

export type TenantScopedClient = Prisma.TransactionClient;

/**
 * Sets the `app.tenant_id` Postgres session variable for the lifetime of one
 * transaction (`set_config(..., true)` — the third `true` argument makes it
 * transaction-local, per Postgres docs), then runs `fn` inside that same
 * transaction. RLS policies (migration `..._add_security_engine`) key off
 * this setting to enforce tenant isolation at the database level — a
 * defense-in-depth backstop for the app-level `WHERE tenantId` filtering
 * every repository already does, and the enforced boundary once a
 * connection actually runs as a non-superuser role (`ai_concierge_api` /
 * `ai_concierge_worker` — see docs/PHASE-6.md §3 for why local dev/CI's
 * default `DATABASE_URL` does not yet make that switch).
 *
 * `tenantId` is passed as a bound parameter (Prisma's tagged-template raw
 * query), never string-interpolated — safe against SQL injection the same
 * way every other raw query in this codebase already is
 * (packages/db/src/repositories/sqlInjection.security.test.ts).
 */
export async function withTenantContext<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: TenantScopedClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
