import {
  Prisma,
  type PrismaClient,
  type EligibilityPolicy as PrismaEligibilityPolicy,
} from '@prisma/client';
import {
  eligibilityPolicyRulesSchema,
  eligibilityPolicySchema,
  type EligibilityPolicy,
  type EligibilityPolicyRules,
  type TenantId,
} from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

/**
 * Re-validates the stored `rules` JSON via Zod on every read — the same
 * "never trust it just because it's our own DB" posture `toDomainVehicle`
 * applies to the vehicle catalog.
 */
export function toDomainEligibilityPolicy(row: PrismaEligibilityPolicy): EligibilityPolicy {
  return eligibilityPolicySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    version: row.version,
    active: row.active,
    rules: eligibilityPolicyRulesSchema.parse(row.rules),
  });
}

/**
 * The tenant's single current policy — the engine always uses this, never a
 * client-supplied policy id or inline override. `null` when the tenant has
 * no policy configured at all (the engine's caller must treat this as
 * `NOT_CONFIGURED`, never fabricate a default).
 */
export async function findActiveEligibilityPolicy(
  db: Executor,
  tenantId: TenantId,
): Promise<EligibilityPolicy | null> {
  const row = await db.eligibilityPolicy.findFirst({
    where: { tenantId, active: true },
    orderBy: { version: 'desc' },
  });
  return row ? toDomainEligibilityPolicy(row) : null;
}

export interface CreateEligibilityPolicyVersionInput {
  tenantId: TenantId;
  rules: EligibilityPolicyRules;
}

/**
 * Inserts a new policy version and deactivates every previous version for
 * the tenant, atomically — a policy is never edited in place, so a past
 * EligibilityDecision's `policyId`/`policyVersion` always resolves to
 * exactly the rules that were applied at decision time. Manages its own
 * transaction boundary (unlike the other repository functions in this
 * package); no caller in this phase needs to compose it inside a larger one.
 */
export async function createEligibilityPolicyVersion(
  db: PrismaClient,
  input: CreateEligibilityPolicyVersionInput,
): Promise<EligibilityPolicy> {
  const validatedRules = eligibilityPolicyRulesSchema.parse(input.rules);
  const created = await db.$transaction(async (tx) => {
    const latest = await tx.eligibilityPolicy.findFirst({
      where: { tenantId: input.tenantId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    await tx.eligibilityPolicy.updateMany({
      where: { tenantId: input.tenantId, active: true },
      data: { active: false },
    });
    return tx.eligibilityPolicy.create({
      data: {
        tenantId: input.tenantId,
        version: (latest?.version ?? 0) + 1,
        active: true,
        rules: validatedRules as unknown as Prisma.InputJsonValue,
      },
    });
  });
  return toDomainEligibilityPolicy(created);
}
