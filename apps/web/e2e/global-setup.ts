import { createTestPrismaClient, seedTestTenants, truncateAllTables } from '@ai-concierge/testing';

/**
 * Runs once before the Playwright suite. Assumes migrations have already
 * been applied to the test database (`pnpm db:migrate` against
 * DATABASE_URL) — this only resets data, it does not manage schema.
 */
export default async function globalSetup(): Promise<void> {
  const prisma = createTestPrismaClient();
  try {
    await prisma.$connect();
    await truncateAllTables(prisma);
    await seedTestTenants(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
