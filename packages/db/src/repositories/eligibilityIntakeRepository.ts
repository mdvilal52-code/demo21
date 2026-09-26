import type { Prisma, PrismaClient } from '@prisma/client';
import type { TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

/**
 * A conversation's stored, customer-claimed Step 5 details. `dateOfBirthEnc`
 * is ciphertext — this layer never sees the plaintext date of birth (the
 * service that owns the encryption key encrypts before writing and decrypts
 * after reading), so a repository bug or a query log can never leak it.
 */
export interface StoredEligibilityIntake {
  conversationId: string;
  dateOfBirthEnc: string | null;
  nationality: string | null;
  licenseType: string | null;
  hasValidLicense: boolean | null;
  passportProvided: boolean | null;
  askedAt: Date | null;
}

export interface EligibilityIntakePatch {
  dateOfBirthEnc?: string | null;
  nationality?: string | null;
  licenseType?: string | null;
  hasValidLicense?: boolean | null;
  passportProvided?: boolean | null;
}

function toStored(row: {
  conversationId: string;
  dateOfBirthEnc: string | null;
  nationality: string | null;
  licenseType: string | null;
  hasValidLicense: boolean | null;
  passportProvided: boolean | null;
  askedAt: Date | null;
}): StoredEligibilityIntake {
  return {
    conversationId: row.conversationId,
    dateOfBirthEnc: row.dateOfBirthEnc,
    nationality: row.nationality,
    licenseType: row.licenseType,
    hasValidLicense: row.hasValidLicense,
    passportProvided: row.passportProvided,
    askedAt: row.askedAt,
  };
}

export async function findEligibilityIntake(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
): Promise<StoredEligibilityIntake | null> {
  const row = await db.eligibilityIntake.findFirst({ where: { tenantId, conversationId } });
  return row ? toStored(row) : null;
}

/**
 * Merges `patch` into the conversation's intake, creating the row on first
 * use. Only the keys present in `patch` are written, so two writers touching
 * different fields never clobber each other, and an absent key never resets a
 * stored value to null.
 */
export async function upsertEligibilityIntake(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
  patch: EligibilityIntakePatch,
): Promise<StoredEligibilityIntake> {
  const row = await db.eligibilityIntake.upsert({
    where: { conversationId },
    create: { tenantId, conversationId, ...patch },
    update: patch,
  });
  return toStored(row);
}

/** Records the first time the concierge asked for these details; later calls never move it. */
export async function markEligibilityIntakeAsked(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
  askedAt: Date,
): Promise<void> {
  await db.eligibilityIntake.upsert({
    where: { conversationId },
    create: { tenantId, conversationId, askedAt },
    update: {},
  });
  await db.eligibilityIntake.updateMany({
    where: { tenantId, conversationId, askedAt: null },
    data: { askedAt },
  });
}
