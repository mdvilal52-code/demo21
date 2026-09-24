import { PrismaClient } from '@prisma/client';
import { hashPassword } from '@ai-concierge/security';

export function requireTestDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || !url.includes('test')) {
    throw new Error(
      'DATABASE_URL must point at a *_test database to run integration tests (refusing to run against a non-test-looking URL).',
    );
  }
  return url;
}

export function createTestPrismaClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: requireTestDatabaseUrl() });
}

/**
 * A Prisma client authenticated as one of the least-privilege roles the
 * `..._add_security_engine` migration creates (`ai_concierge_api` /
 * `ai_concierge_worker`), built by swapping the test superuser URL's
 * credentials — everything else (host/port/database) stays identical. Used
 * only by the RLS/least-privilege proof tests
 * (packages/db/src/repositories/rowLevelSecurity.security.test.ts): the rest
 * of the suite intentionally keeps using the superuser connection for local
 * dev/CI convenience — see docs/PHASE-6.md §3.
 */
export function createScopedRoleTestPrismaClient(
  role: 'ai_concierge_api' | 'ai_concierge_worker',
): PrismaClient {
  const url = new URL(requireTestDatabaseUrl());
  url.username = role;
  url.password = 'change-me-in-production';
  return new PrismaClient({ datasourceUrl: url.toString() });
}

const TABLES = [
  'security_events',
  'refresh_tokens',
  'users',
  'audit_events',
  'missing_info_checks',
  'vehicle_determinations',
  'date_location_extractions',
  'intent_records',
  'idempotency_keys',
  'messages',
  'conversations',
  'vehicles',
  'tenants',
];

export async function truncateAllTables(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE;`);
}

export const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const OTHER_TENANT_ID = '00000000-0000-0000-0000-000000000002';

export async function seedTestTenants(prisma: PrismaClient): Promise<void> {
  await prisma.tenant.createMany({
    data: [
      { id: TEST_TENANT_ID, name: 'Test Tenant' },
      { id: OTHER_TENANT_ID, name: 'Other Tenant' },
    ],
    skipDuplicates: true,
  });
}

export const TEST_USER_PASSWORD = 'Correct-Horse-Battery-Staple-1!';

export interface SeedTestUserOptions {
  tenantId?: string;
  email?: string;
  role?: 'ADMIN' | 'MANAGER' | 'OPS_AGENT' | 'SECURITY';
}

/** A real argon2 hash of TEST_USER_PASSWORD — tests log in with the real password, never a stubbed hash check. */
export async function seedTestUser(prisma: PrismaClient, options: SeedTestUserOptions = {}) {
  return prisma.user.create({
    data: {
      tenantId: options.tenantId ?? TEST_TENANT_ID,
      email: options.email ?? 'ops@example.com',
      passwordHash: await hashPassword(TEST_USER_PASSWORD),
      role: options.role ?? 'ADMIN',
    },
  });
}
