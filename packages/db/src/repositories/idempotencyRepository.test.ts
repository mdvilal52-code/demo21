import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findIdempotencyKey, saveIdempotencyKey } from './idempotencyRepository.js';

describe('idempotencyRepository', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedTestTenants(prisma);
  });

  it('returns null for a key that has not been used', async () => {
    const result = await findIdempotencyKey(prisma, 'unused-key');
    expect(result).toBeNull();
  });

  it('stores and replays a response for a given key', async () => {
    await saveIdempotencyKey(prisma, {
      key: 'req-123',
      tenantId: TEST_TENANT_ID,
      requestHash: 'hash-abc',
      responseStatus: 201,
      responseBody: { ok: true, conversationId: 'c-1' },
    });

    const result = await findIdempotencyKey(prisma, 'req-123');
    expect(result?.responseStatus).toBe(201);
    expect(result?.responseBody).toEqual({ ok: true, conversationId: 'c-1' });
  });

  it('rejects a duplicate key (the caller is expected to catch this and replay instead)', async () => {
    await saveIdempotencyKey(prisma, {
      key: 'req-456',
      tenantId: TEST_TENANT_ID,
      requestHash: 'hash-1',
      responseStatus: 200,
      responseBody: {},
    });
    await expect(
      saveIdempotencyKey(prisma, {
        key: 'req-456',
        tenantId: TEST_TENANT_ID,
        requestHash: 'hash-2',
        responseStatus: 200,
        responseBody: {},
      }),
    ).rejects.toThrow();
  });
});
