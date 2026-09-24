import { randomUUID } from 'node:crypto';
import {
  createTestPrismaClient,
  createScopedRoleTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenantContext } from '../tenantContext.js';

/**
 * Proves the migration `..._add_security_engine`'s RLS policies and
 * least-privilege roles are real, not just declared — connects AS
 * `ai_concierge_api` (no BYPASSRLS, not the table owner) against real
 * Postgres, the same way a compromised API credential would. This is the
 * kill-chain test's tenant-isolation layer in isolation; the end-to-end
 * chain lives in killChain.security.test.ts.
 */
describe('Row Level Security + least-privilege DB roles', () => {
  let admin: PrismaClient;
  let scoped: PrismaClient;
  let conversationInTenantA: { id: string };

  beforeAll(async () => {
    admin = createTestPrismaClient();
    await admin.$connect();
    scoped = createScopedRoleTestPrismaClient('ai_concierge_api');
    await scoped.$connect();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await scoped.$disconnect();
  });

  beforeEach(async () => {
    await truncateAllTables(admin);
    await seedTestTenants(admin);
    conversationInTenantA = await admin.conversation.create({
      data: {
        tenantId: TEST_TENANT_ID,
        channel: 'WEB',
        customerRef: 'customer-a',
      },
    });
    await admin.conversation.create({
      data: {
        tenantId: OTHER_TENANT_ID,
        channel: 'WEB',
        customerRef: 'customer-b',
      },
    });
  });

  it('sees only its own tenant when app.tenant_id is set', async () => {
    const rows = await withTenantContext(scoped, TEST_TENANT_ID, (tx) =>
      tx.conversation.findMany(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TEST_TENANT_ID);
  });

  it('cannot read another tenant row even by its exact, known id', async () => {
    const rows = await withTenantContext(scoped, OTHER_TENANT_ID, (tx) =>
      tx.conversation.findMany({ where: { id: conversationInTenantA.id } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('fails closed with zero rows when no tenant context is set at all', async () => {
    const rows = await scoped.conversation.findMany();
    expect(rows).toHaveLength(0);
  });

  it('cannot write a row into a tenant other than the one set in context', async () => {
    await expect(
      withTenantContext(scoped, TEST_TENANT_ID, (tx) =>
        tx.conversation.create({
          data: { tenantId: OTHER_TENANT_ID, channel: 'WEB', customerRef: 'attacker' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('the api role has no DELETE privilege (append-only-by-privilege, not just by convention)', async () => {
    await expect(
      withTenantContext(scoped, TEST_TENANT_ID, (tx) =>
        tx.conversation.delete({ where: { id: conversationInTenantA.id } }),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the api role cannot bypass RLS, is not a superuser, and cannot create roles', async () => {
    const rows = await admin.$queryRaw<
      { rolbypassrls: boolean; rolsuper: boolean; rolcreaterole: boolean }[]
    >`SELECT rolbypassrls, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = 'ai_concierge_api'`;
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false, rolcreaterole: false });
  });

  it('the worker role is narrower than the api role — cannot write vehicles', async () => {
    const workerClient = createScopedRoleTestPrismaClient('ai_concierge_worker');
    await workerClient.$connect();
    try {
      await expect(
        withTenantContext(workerClient, TEST_TENANT_ID, (tx) =>
          tx.vehicle.create({
            data: {
              tenantId: TEST_TENANT_ID,
              make: 'Lamborghini',
              model: 'Urus',
              category: 'SUV',
              luxuryTier: 'ULTRA_LUXURY',
              seats: 5,
              luggage: 2,
              transmission: 'AUTOMATIC',
              pricingProfile: { currency: 'AED', dailyRate: 500000 },
            },
          }),
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await workerClient.$disconnect();
    }
  });

  it('a raw session (no context) reading tenants directly sees nothing — the tenants table itself is isolated too', async () => {
    const rows = await scoped.$queryRaw<{ id: string }[]>`SELECT id FROM tenants`;
    expect(rows).toHaveLength(0);
  });

  it('setting an unrelated/garbage tenant id yields zero rows rather than an error (fails closed, not crashed)', async () => {
    const rows = await withTenantContext(scoped, randomUUID(), (tx) => tx.conversation.findMany());
    expect(rows).toHaveLength(0);
  });
});
