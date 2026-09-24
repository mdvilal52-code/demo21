import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createUser,
  enableMfa,
  findUserByEmail,
  findUserById,
  MAX_FAILED_LOGINS_BEFORE_LOCK,
  recordLoginFailure,
  resetLoginFailures,
  setMfaSecret,
  setUserStatus,
} from './userRepository.js';

describe('userRepository', () => {
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

  it('creates a user and normalizes email to lowercase', async () => {
    const user = await createUser(prisma, {
      tenantId: TEST_TENANT_ID,
      email: 'Ops@Example.COM',
      passwordHash: 'hash',
      role: 'OPS_AGENT',
    });
    expect(user.email).toBe('ops@example.com');
  });

  it('findUserByEmail is case-insensitive and tenant-scoped', async () => {
    await createUser(prisma, {
      tenantId: TEST_TENANT_ID,
      email: 'manager@example.com',
      passwordHash: 'hash',
      role: 'MANAGER',
    });

    expect(await findUserByEmail(prisma, TEST_TENANT_ID, 'MANAGER@EXAMPLE.COM')).not.toBeNull();
    expect(await findUserByEmail(prisma, OTHER_TENANT_ID, 'manager@example.com')).toBeNull();
  });

  it('the same email may exist under two different tenants', async () => {
    await createUser(prisma, {
      tenantId: TEST_TENANT_ID,
      email: 'shared@example.com',
      passwordHash: 'hash-a',
      role: 'ADMIN',
    });
    const other = await createUser(prisma, {
      tenantId: OTHER_TENANT_ID,
      email: 'shared@example.com',
      passwordHash: 'hash-b',
      role: 'ADMIN',
    });
    expect(other.tenantId).toBe(OTHER_TENANT_ID);
  });

  it('rejects a duplicate email within the same tenant', async () => {
    await createUser(prisma, {
      tenantId: TEST_TENANT_ID,
      email: 'dup@example.com',
      passwordHash: 'hash',
      role: 'ADMIN',
    });
    await expect(
      createUser(prisma, {
        tenantId: TEST_TENANT_ID,
        email: 'dup@example.com',
        passwordHash: 'hash2',
        role: 'ADMIN',
      }),
    ).rejects.toThrow();
  });

  it('locks the account after MAX_FAILED_LOGINS_BEFORE_LOCK failures', async () => {
    const user = await createUser(prisma, {
      tenantId: TEST_TENANT_ID,
      email: 'lockout@example.com',
      passwordHash: 'hash',
      role: 'ADMIN',
    });

    let locked = false;
    for (let i = 0; i < MAX_FAILED_LOGINS_BEFORE_LOCK; i++) {
      locked = await recordLoginFailure(prisma, user.id);
    }
    expect(locked).toBe(true);

    const reloaded = await findUserById(prisma, TEST_TENANT_ID, user.id);
    expect(reloaded?.failedLoginCount).toBe(MAX_FAILED_LOGINS_BEFORE_LOCK);
    expect(reloaded?.lockedUntil).not.toBeNull();
  });

  it('resetLoginFailures clears the counter and lock', async () => {
    const user = await createUser(prisma, {
      tenantId: TEST_TENANT_ID,
      email: 'reset@example.com',
      passwordHash: 'hash',
      role: 'ADMIN',
    });
    for (let i = 0; i < MAX_FAILED_LOGINS_BEFORE_LOCK; i++) {
      await recordLoginFailure(prisma, user.id);
    }
    await resetLoginFailures(prisma, user.id);
    const reloaded = await findUserById(prisma, TEST_TENANT_ID, user.id);
    expect(reloaded?.failedLoginCount).toBe(0);
    expect(reloaded?.lockedUntil).toBeNull();
  });

  it('MFA enrollment: setMfaSecret then enableMfa', async () => {
    const user = await createUser(prisma, {
      tenantId: TEST_TENANT_ID,
      email: 'mfa@example.com',
      passwordHash: 'hash',
      role: 'ADMIN',
    });
    await setMfaSecret(prisma, user.id, 'ciphertext-value');
    let reloaded = await findUserById(prisma, TEST_TENANT_ID, user.id);
    expect(reloaded?.mfaSecretCiphertext).toBe('ciphertext-value');
    expect(reloaded?.mfaEnabled).toBe(false);

    await enableMfa(prisma, user.id);
    reloaded = await findUserById(prisma, TEST_TENANT_ID, user.id);
    expect(reloaded?.mfaEnabled).toBe(true);
  });

  it('setUserStatus suspends an account', async () => {
    const user = await createUser(prisma, {
      tenantId: TEST_TENANT_ID,
      email: 'suspend@example.com',
      passwordHash: 'hash',
      role: 'ADMIN',
    });
    await setUserStatus(prisma, user.id, 'SUSPENDED');
    const reloaded = await findUserById(prisma, TEST_TENANT_ID, user.id);
    expect(reloaded?.status).toBe('SUSPENDED');
  });
});
