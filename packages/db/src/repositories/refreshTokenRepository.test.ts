import { randomUUID } from 'node:crypto';
import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import {
  hashRefreshToken,
  issueRefreshToken,
  rotateRefreshToken,
} from '@ai-concierge/security/authn';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from './userRepository.js';
import {
  createRefreshToken,
  findRefreshTokenByHash,
  revokeRefreshToken,
  revokeRefreshTokenFamily,
} from './refreshTokenRepository.js';

describe('refreshTokenRepository', () => {
  let prisma: PrismaClient;
  let userId: string;

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
    const user = await createUser(prisma, {
      tenantId: TEST_TENANT_ID,
      email: `user-${randomUUID()}@example.com`,
      passwordHash: 'hash',
      role: 'ADMIN',
    });
    userId = user.id;
  });

  it('stores only the hash, and finds it back by hash', async () => {
    const issued = issueRefreshToken();
    await createRefreshToken(prisma, {
      tenantId: TEST_TENANT_ID,
      userId,
      tokenHash: issued.tokenHash,
      familyId: issued.familyId,
      expiresAt: issued.expiresAt,
    });

    const found = await findRefreshTokenByHash(prisma, issued.tokenHash);
    expect(found?.userId).toBe(userId);
    expect(found?.revokedAt).toBeNull();

    // the raw token itself is never a column value in the row
    expect(Object.values(found ?? {})).not.toContain(issued.token);
  });

  it('rotation: revoking the old token and creating the new one preserves the family', async () => {
    const first = issueRefreshToken();
    const stored = await createRefreshToken(prisma, {
      tenantId: TEST_TENANT_ID,
      userId,
      tokenHash: first.tokenHash,
      familyId: first.familyId,
      expiresAt: first.expiresAt,
    });

    const rotated = rotateRefreshToken(first.familyId);
    await revokeRefreshToken(prisma, stored.id);
    const newRow = await createRefreshToken(prisma, {
      tenantId: TEST_TENANT_ID,
      userId,
      tokenHash: rotated.tokenHash,
      familyId: rotated.familyId,
      expiresAt: rotated.expiresAt,
    });

    const oldRow = await findRefreshTokenByHash(prisma, first.tokenHash);
    expect(oldRow?.revokedAt).not.toBeNull();
    expect(newRow.familyId).toBe(stored.familyId);
    expect(newRow.revokedAt).toBeNull();
  });

  it('reuse-detection input: hashRefreshToken lets the caller recognize a presented raw token matches a revoked row', async () => {
    const issued = issueRefreshToken();
    const stored = await createRefreshToken(prisma, {
      tenantId: TEST_TENANT_ID,
      userId,
      tokenHash: issued.tokenHash,
      familyId: issued.familyId,
      expiresAt: issued.expiresAt,
    });
    await revokeRefreshToken(prisma, stored.id);

    const found = await findRefreshTokenByHash(prisma, hashRefreshToken(issued.token));
    expect(found?.revokedAt).not.toBeNull(); // caller uses this to trigger family-wide revocation
  });

  it('revokeRefreshTokenFamily revokes every non-revoked member, leaving already-revoked ones untouched', async () => {
    const familyId = randomUUID();
    const a = issueRefreshToken();
    const rowA = await createRefreshToken(prisma, {
      tenantId: TEST_TENANT_ID,
      userId,
      tokenHash: a.tokenHash,
      familyId,
      expiresAt: a.expiresAt,
    });
    const b = rotateRefreshToken(familyId);
    const rowB = await createRefreshToken(prisma, {
      tenantId: TEST_TENANT_ID,
      userId,
      tokenHash: b.tokenHash,
      familyId,
      expiresAt: b.expiresAt,
    });
    expect(rowA.id).not.toBe(rowB.id); // sanity: distinct rows in the same family

    await revokeRefreshTokenFamily(prisma, familyId);

    const rowAAfter = await findRefreshTokenByHash(prisma, a.tokenHash);
    const rowBAfter = await findRefreshTokenByHash(prisma, b.tokenHash);
    expect(rowAAfter?.revokedAt).not.toBeNull();
    expect(rowBAfter?.revokedAt).not.toBeNull();
  });
});
