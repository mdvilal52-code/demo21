// Idempotent first-admin bootstrap: a fresh deploy has a tenant and a
// fleet (see seed.ts) but, before this runs, literally no staff account —
// nothing to sign into the Admin Dashboard with. Only `POST /v1/users` (the
// human-provisioning route) doesn't exist yet by design (Permission.USER_*
// is a Security-tier concern, not part of this phase), so this fills the
// one gap that would otherwise be a "real-world pilot with a dashboard
// nobody can log into". Safe to re-run: skips if the account already
// exists, never resets an existing password.
import { hashPassword } from '@ai-concierge/security/authn';
import { createPrismaClient } from './index.js';
import { createUser, findUserByEmail } from './repositories/userRepository.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const tenantId = process.env.DEFAULT_TENANT_ID;
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!databaseUrl || !tenantId) {
    throw new Error('DATABASE_URL and DEFAULT_TENANT_ID must both be set to run this script');
  }
  if (!email || !password) {
    console.error(
      'BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD not set — skipping first-admin bootstrap. ' +
        'Set both and re-run `pnpm --filter @ai-concierge/db run bootstrap-admin` to create one.',
    );
    return;
  }
  if (password.length < 12) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');
  }

  const prisma = createPrismaClient(databaseUrl);
  try {
    const existing = await findUserByEmail(prisma, tenantId, email);
    if (existing) {
      console.error(`Bootstrap admin skipped: ${email} already exists for tenant ${tenantId}.`);
      return;
    }

    const passwordHash = await hashPassword(password);
    await createUser(prisma, { tenantId, email, passwordHash, role: 'ADMIN' });
    console.error(`Bootstrap admin created: ${email} (ADMIN) for tenant ${tenantId}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Bootstrap admin failed', error);
  process.exit(1);
});
