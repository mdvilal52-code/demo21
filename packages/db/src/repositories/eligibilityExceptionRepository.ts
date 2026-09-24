import {
  Prisma,
  type PrismaClient,
  type EligibilityException as PrismaEligibilityException,
} from '@prisma/client';
import {
  createEligibilityExceptionInputSchema,
  eligibilityExceptionSchema,
  type EligibilityException,
  type EligibilityExceptionTypeValue,
  type EligibilityRiskLevelValue,
  type EligibilityRuleCategoryValue,
  type TenantId,
} from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export function toDomainEligibilityException(
  row: PrismaEligibilityException,
): EligibilityException {
  return eligibilityExceptionSchema.parse({
    id: row.id,
    type: row.type,
    scopeCustomerRef: row.scopeCustomerRef,
    scopeNationality: row.scopeNationality,
    waivedCategories: row.waivedCategories,
    riskLevel: row.riskLevel,
    reason: row.reason,
    active: row.active,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  });
}

export interface CreateEligibilityExceptionInput {
  tenantId: TenantId;
  type: EligibilityExceptionTypeValue;
  scopeCustomerRef?: string | null;
  scopeNationality?: string | null;
  waivedCategories: EligibilityRuleCategoryValue[];
  riskLevel: EligibilityRiskLevelValue;
  reason: string;
  expiresAt?: Date | null;
}

/**
 * A tenant-configured, pre-approved carve-out — never created by the engine
 * itself. Validated before the write (see `createEligibilityExceptionInputSchema`)
 * so a malformed `waivedCategories`/`scopeNationality` fails loudly here,
 * not as a `toDomainEligibilityException` parse error on every later read.
 */
export async function createEligibilityException(
  db: Executor,
  input: CreateEligibilityExceptionInput,
) {
  const validated = createEligibilityExceptionInputSchema.parse({
    type: input.type,
    scopeCustomerRef: input.scopeCustomerRef ?? null,
    scopeNationality: input.scopeNationality ?? null,
    waivedCategories: input.waivedCategories,
    riskLevel: input.riskLevel,
    reason: input.reason,
    expiresAt: input.expiresAt ?? null,
  });
  return db.eligibilityException.create({
    data: {
      tenantId: input.tenantId,
      type: validated.type as Prisma.EligibilityExceptionCreateInput['type'],
      scopeCustomerRef: validated.scopeCustomerRef,
      scopeNationality: validated.scopeNationality,
      waivedCategories: validated.waivedCategories,
      riskLevel: validated.riskLevel as Prisma.EligibilityExceptionCreateInput['riskLevel'],
      reason: validated.reason,
      expiresAt: validated.expiresAt,
    },
  });
}

/**
 * Every active, non-expired exception that could apply to this customer —
 * matched by customer reference (VIP / AGE_OVERRIDE / MANUAL_GRANT) or by
 * nationality (NATIONALITY_OVERRIDE). Tenant-scoped; never matches another
 * tenant's exception. The engine (packages/ai/src/step5) decides which of
 * these, if any, actually apply to a specific failed rule.
 */
export async function findApplicableEligibilityExceptions(
  db: Executor,
  tenantId: TenantId,
  params: { customerRef: string; nationality: string },
): Promise<EligibilityException[]> {
  const now = new Date();
  const rows = await db.eligibilityException.findMany({
    where: {
      tenantId,
      active: true,
      OR: [{ scopeCustomerRef: params.customerRef }, { scopeNationality: params.nationality }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
  });
  return rows.map(toDomainEligibilityException);
}
