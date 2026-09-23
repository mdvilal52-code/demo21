import { Prisma, type PrismaClient } from '@prisma/client';
import type { EligibilityDecisionResult, TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export interface CreateEligibilityDecisionInput {
  tenantId: TenantId;
  messageId: string;
  result: EligibilityDecisionResult;
}

/** Append-only — same "store the validated engine output verbatim" convention as every prior step. */
export async function createEligibilityDecision(
  db: Executor,
  input: CreateEligibilityDecisionInput,
) {
  const { result } = input;
  return db.eligibilityDecision.create({
    data: {
      tenantId: input.tenantId,
      messageId: input.messageId,
      status: result.status,
      ruleResults: result.ruleResults as unknown as Prisma.InputJsonValue,
      exceptionsApplied: result.exceptionsApplied as unknown as Prisma.InputJsonValue,
      policyConflicts: result.policyConflicts as unknown as Prisma.InputJsonValue,
      reason: result.reason,
      policyId: result.policyId,
      policyVersion: result.policyVersion,
      flags: result.flags,
      modelMetadata: result.modelMetadata,
    },
  });
}

/** Tenant-scoped read — same isolation convention as the other repositories. */
export async function findLatestEligibilityDecisionForMessage(
  db: Executor,
  tenantId: TenantId,
  messageId: string,
) {
  return db.eligibilityDecision.findFirst({
    where: { tenantId, messageId },
    orderBy: { createdAt: 'desc' },
  });
}
