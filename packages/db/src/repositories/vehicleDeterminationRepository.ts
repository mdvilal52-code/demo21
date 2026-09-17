import type { Prisma, PrismaClient } from '@prisma/client';
import type { TenantId, VehicleDeterminationResult } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export interface CreateVehicleDeterminationInput {
  tenantId: TenantId;
  messageId: string;
  result: VehicleDeterminationResult;
}

export async function createVehicleDetermination(
  db: Executor,
  input: CreateVehicleDeterminationInput,
) {
  const { result } = input;
  return db.vehicleDetermination.create({
    data: {
      tenantId: input.tenantId,
      messageId: input.messageId,
      resolvedVehicleId: result.resolvedVehicle?.id ?? null,
      status: result.status,
      confidence: result.confidence,
      ambiguities: result.ambiguities as unknown as Prisma.InputJsonValue,
      validationErrors: result.validationErrors as unknown as Prisma.InputJsonValue,
      alternatives: result.alternatives as unknown as Prisma.InputJsonValue,
      flags: result.flags,
      modelMetadata: result.modelMetadata,
    },
  });
}

/**
 * Tenant-scoped read — same isolation convention as the other repositories.
 * Includes the related `resolvedVehicle` row (map via `toDomainVehicle` from
 * `vehicleRepository.ts` when the caller needs the public domain shape, e.g.
 * Step 4's completeness check) rather than just the bare `resolvedVehicleId`.
 */
export async function findLatestVehicleDeterminationForMessage(
  db: Executor,
  tenantId: TenantId,
  messageId: string,
) {
  return db.vehicleDetermination.findFirst({
    where: { tenantId, messageId },
    orderBy: { createdAt: 'desc' },
    include: { resolvedVehicle: true },
  });
}
