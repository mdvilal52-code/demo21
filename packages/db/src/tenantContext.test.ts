import { createTestPrismaClient } from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantContext } from './tenantContext.js';

describe('withTenantContext', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('makes app.tenant_id readable inside the callback', async () => {
    const tenantId = '11111111-1111-1111-1111-111111111111';
    const seen = await withTenantContext(prisma, tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        { value: string }[]
      >`SELECT current_setting('app.tenant_id', true) AS value`;
      return rows[0]?.value;
    });
    expect(seen).toBe(tenantId);
  });

  it('does not leak the setting to a query outside the transaction (transaction-local via set_config true)', async () => {
    await withTenantContext(prisma, '22222222-2222-2222-2222-222222222222', async () => {});

    const rows = await prisma.$queryRaw<
      { value: string | null }[]
    >`SELECT current_setting('app.tenant_id', true) AS value`;
    expect(rows[0]?.value).not.toBe('22222222-2222-2222-2222-222222222222');
  });

  it('propagates an error thrown inside the callback (no swallowing)', async () => {
    await expect(
      withTenantContext(prisma, '33333333-3333-3333-3333-333333333333', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
