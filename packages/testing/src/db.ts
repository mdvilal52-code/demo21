import { PrismaClient } from '@prisma/client';

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

const TABLES = [
  'audit_events',
  'intent_records',
  'idempotency_keys',
  'messages',
  'conversations',
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
