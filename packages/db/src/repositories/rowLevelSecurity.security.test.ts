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

/**
 * `refresh_tokens` and `idempotency_keys` deliberately do NOT use the
 * blanket tenant_isolation policy — they are looked up by an opaque secret
 * alone, before any tenant is known (see migration
 * `..._fix_bearer_token_rls_policies` for why the blanket policy is a
 * landmine for exactly these two tables). Proves the replacement policies:
 * SELECT is unconditional (the secret is the real access control), but
 * INSERT/UPDATE stay tenant-scoped.
 */
describe('Row Level Security — bearer-secret tables (refresh_tokens, idempotency_keys)', () => {
  let admin: PrismaClient;
  let scoped: PrismaClient;

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
  });

  it('finds a refresh token by hash with NO tenant context set at all', async () => {
    const user = await admin.user.create({
      data: {
        tenantId: TEST_TENANT_ID,
        email: 'bearer-test@example.com',
        passwordHash: 'irrelevant-for-this-test',
        role: 'ADMIN',
      },
    });
    await admin.refreshToken.create({
      data: {
        tenantId: TEST_TENANT_ID,
        userId: user.id,
        tokenHash: 'a-fixed-test-hash-value',
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    // No withTenantContext at all — exactly how findRefreshTokenByHash calls it.
    const found = await scoped.refreshToken.findUnique({
      where: { tokenHash: 'a-fixed-test-hash-value' },
    });
    expect(found?.userId).toBe(user.id);
  });

  it('still refuses to INSERT a refresh token under the wrong tenant context', async () => {
    const user = await admin.user.create({
      data: {
        tenantId: TEST_TENANT_ID,
        email: 'bearer-write-test@example.com',
        passwordHash: 'irrelevant-for-this-test',
        role: 'ADMIN',
      },
    });

    await expect(
      withTenantContext(scoped, OTHER_TENANT_ID, (tx) =>
        tx.refreshToken.create({
          data: {
            tenantId: TEST_TENANT_ID, // mismatched on purpose
            userId: user.id,
            tokenHash: 'another-fixed-test-hash',
            familyId: randomUUID(),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('finds an idempotency key by its key alone with no tenant context', async () => {
    await admin.idempotencyKey.create({
      data: {
        key: 'a-fixed-idempotency-key',
        tenantId: TEST_TENANT_ID,
        requestHash: 'hash',
        responseStatus: 201,
        responseBody: {},
      },
    });
    const found = await scoped.idempotencyKey.findUnique({
      where: { key: 'a-fixed-idempotency-key' },
    });
    expect(found?.tenantId).toBe(TEST_TENANT_ID);
  });
});

/**
 * Proves the fix bundled into migration `..._add_workflow_engine_crm`:
 * `quotes` (Step 8) was created before `..._add_security_engine` ran and,
 * like `eligibility_*`/`vehicle_units`/`availability_*`/
 * `alternative_recommendations`, silently had neither RLS nor an
 * `ai_concierge_api` grant — invisible in every earlier test because they
 * all ran as the admin/superuser connection. `quotes` stands in for the
 * whole group here (same blanket `tenant_isolation` policy, same fix); a
 * table-by-table repeat would just be this test eight times over.
 */
describe('Row Level Security — retroactive fix for tables predating the security migration', () => {
  let admin: PrismaClient;
  let scoped: PrismaClient;

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
  });

  it('the api role can now read/write quotes at all (previously had no GRANT whatsoever)', async () => {
    const conversation = await admin.conversation.create({
      data: { tenantId: TEST_TENANT_ID, channel: 'WEB', customerRef: 'quote-customer' },
    });
    const message = await admin.message.create({
      data: { conversationId: conversation.id, content: 'quote please' },
    });
    const vehicle = await admin.vehicle.create({
      data: {
        tenantId: TEST_TENANT_ID,
        make: 'Rolls-Royce',
        model: 'Cullinan',
        category: 'SUV',
        luxuryTier: 'ULTRA_LUXURY',
        seats: 5,
        luggage: 3,
        transmission: 'AUTOMATIC',
        pricingProfile: { currency: 'AED', dailyRate: 700000 },
      },
    });

    const created = await withTenantContext(scoped, TEST_TENANT_ID, (tx) =>
      tx.quote.create({
        data: {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          messageId: message.id,
          vehicleId: vehicle.id,
          quoteId: randomUUID(),
          version: 1,
          status: 'ISSUED',
          currency: 'AED',
          lineItems: [],
          taxes: [],
          fees: [],
          discounts: [],
          deposit: { minorUnits: 0, currency: 'AED' },
          total: { minorUnits: 0, currency: 'AED' },
          validUntil: new Date(Date.now() + 60_000),
          pricingVersion: 'v1',
          requiresHumanReview: false,
          reviewReasons: [],
          integrityHash: 'test',
          modelMetadata: {},
        },
      }),
    );
    expect(created.tenantId).toBe(TEST_TENANT_ID);
  });

  it('quotes are tenant-isolated for the api role, exactly like every other table', async () => {
    const conversation = await admin.conversation.create({
      data: { tenantId: OTHER_TENANT_ID, channel: 'WEB', customerRef: 'other-tenant-customer' },
    });
    const message = await admin.message.create({
      data: { conversationId: conversation.id, content: 'quote please' },
    });
    const vehicle = await admin.vehicle.create({
      data: {
        tenantId: OTHER_TENANT_ID,
        make: 'Bentley',
        model: 'Bentayga',
        category: 'SUV',
        luxuryTier: 'LUXURY',
        seats: 5,
        luggage: 3,
        transmission: 'AUTOMATIC',
        pricingProfile: { currency: 'AED', dailyRate: 400000 },
      },
    });
    await admin.quote.create({
      data: {
        tenantId: OTHER_TENANT_ID,
        conversationId: conversation.id,
        messageId: message.id,
        vehicleId: vehicle.id,
        quoteId: randomUUID(),
        version: 1,
        status: 'ISSUED',
        currency: 'AED',
        lineItems: [],
        taxes: [],
        fees: [],
        discounts: [],
        deposit: { minorUnits: 0, currency: 'AED' },
        total: { minorUnits: 0, currency: 'AED' },
        validUntil: new Date(Date.now() + 60_000),
        pricingVersion: 'v1',
        requiresHumanReview: false,
        reviewReasons: [],
        integrityHash: 'test',
        modelMetadata: {},
      },
    });

    const rows = await withTenantContext(scoped, TEST_TENANT_ID, (tx) => tx.quote.findMany());
    expect(rows).toHaveLength(0);
  });
});

/**
 * This migration's own new tables (journeys, escalation_cases, customers) —
 * same RLS + least-privilege proof, so the gap the group above closes is
 * never reintroduced by a future table that forgets it.
 */
describe('Row Level Security — journeys, escalation_cases, customers (this migration)', () => {
  let admin: PrismaClient;
  let scoped: PrismaClient;

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
  });

  it('journeys are tenant-isolated for the api role', async () => {
    const conversationA = await admin.conversation.create({
      data: { tenantId: TEST_TENANT_ID, channel: 'WEB', customerRef: 'a' },
    });
    const conversationB = await admin.conversation.create({
      data: { tenantId: OTHER_TENANT_ID, channel: 'WEB', customerRef: 'b' },
    });
    await admin.journey.create({
      data: { tenantId: TEST_TENANT_ID, conversationId: conversationA.id, context: {} },
    });
    await admin.journey.create({
      data: { tenantId: OTHER_TENANT_ID, conversationId: conversationB.id, context: {} },
    });

    const rows = await withTenantContext(scoped, TEST_TENANT_ID, (tx) => tx.journey.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TEST_TENANT_ID);
  });

  it('escalation_cases are tenant-isolated for the api role', async () => {
    const conversation = await admin.conversation.create({
      data: { tenantId: OTHER_TENANT_ID, channel: 'WEB', customerRef: 'c' },
    });
    const journey = await admin.journey.create({
      data: { tenantId: OTHER_TENANT_ID, conversationId: conversation.id, context: {} },
    });
    await admin.escalationCase.create({
      data: {
        tenantId: OTHER_TENANT_ID,
        journeyId: journey.id,
        tier: 'T2',
        reason: 'MISSING_INFO_STALLED',
        detail: 'x',
        slaDueAt: new Date(Date.now() + 60_000),
      },
    });

    const rows = await withTenantContext(scoped, TEST_TENANT_ID, (tx) =>
      tx.escalationCase.findMany(),
    );
    expect(rows).toHaveLength(0);
  });

  it('customers are tenant-isolated for the api role even with the same customerRef', async () => {
    await admin.customer.create({
      data: { tenantId: TEST_TENANT_ID, channel: 'WHATSAPP', customerRef: '+15551234567' },
    });
    await admin.customer.create({
      data: { tenantId: OTHER_TENANT_ID, channel: 'WHATSAPP', customerRef: '+15551234567' },
    });

    const rows = await withTenantContext(scoped, TEST_TENANT_ID, (tx) => tx.customer.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TEST_TENANT_ID);
  });

  it('the api role still has no DELETE on the new tables either', async () => {
    const conversation = await admin.conversation.create({
      data: { tenantId: TEST_TENANT_ID, channel: 'WEB', customerRef: 'd' },
    });
    const journey = await admin.journey.create({
      data: { tenantId: TEST_TENANT_ID, conversationId: conversation.id, context: {} },
    });

    await expect(
      withTenantContext(scoped, TEST_TENANT_ID, (tx) =>
        tx.journey.delete({ where: { id: journey.id } }),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
