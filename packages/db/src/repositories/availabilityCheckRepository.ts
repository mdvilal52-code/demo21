import type { Prisma, PrismaClient } from '@prisma/client';
import type { AvailabilityCheckResult, TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export interface CreateAvailabilityCheckInput {
  tenantId: TenantId;
  messageId: string;
  result: AvailabilityCheckResult;
}

/** Same append-only-history convention as IntentRecord/VehicleDetermination/MissingInfoCheck. */
export async function createAvailabilityCheck(db: Executor, input: CreateAvailabilityCheckInput) {
  const { result } = input;
  return db.availabilityCheck.create({
    data: {
      tenantId: input.tenantId,
      messageId: input.messageId,
      vehicleId: result.vehicleId,
      pickupAt: new Date(result.pickupDate),
      returnAt: new Date(result.returnDate),
      status: result.status,
      holdId: result.hold?.id ?? null,
      source: result.source,
      reason: result.reason,
      retryable: result.retryable,
      modelMetadata: result.modelMetadata,
    },
  });
}

/** Tenant-scoped read — same isolation convention as the other repositories. */
export async function findLatestAvailabilityCheckForMessage(
  db: Executor,
  tenantId: TenantId,
  messageId: string,
) {
  return db.availabilityCheck.findFirst({
    where: { tenantId, messageId },
    orderBy: { createdAt: 'desc' },
  });
}
