import type { VehicleDeterminationOrchestrator } from '@ai-concierge/ai';
import {
  createVehicleDetermination,
  findLatestMessageForConversation,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, type TenantId } from '@ai-concierge/domain';
import type { DetermineVehicleResponse } from '@ai-concierge/contracts';

export interface VehicleServiceDeps {
  prisma: PrismaClient;
  orchestrator: VehicleDeterminationOrchestrator;
}

export interface DetermineVehicleInput {
  tenantId: TenantId;
  conversationId: string;
  requestId: string;
}

/**
 * Step 3 — Determine Vehicle. Input is a Phase 1 conversation's latest
 * message (already validated at ingestion); this never accepts raw
 * customer text directly. AI proposes (`VehicleIntentService`, inside the
 * orchestrator); deterministic domain logic verifies against the real fleet
 * (`VehicleCatalogService` + `VehicleValidationService`) before anything is
 * persisted or returned.
 */
export async function determineVehicle(
  deps: VehicleServiceDeps,
  input: DetermineVehicleInput,
): Promise<DetermineVehicleResponse> {
  const message = await findLatestMessageForConversation(
    deps.prisma,
    input.tenantId,
    input.conversationId,
  );
  if (!message) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }

  const determination = await deps.orchestrator.determine(message.content, {
    tenantId: input.tenantId,
  });

  await deps.prisma.$transaction(async (tx) => {
    await createVehicleDetermination(tx, {
      tenantId: input.tenantId,
      messageId: message.id,
      result: determination,
    });

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: input.tenantId,
      actor: 'system:vehicle-determination',
      action: 'vehicle.determined',
      entityType: 'Message',
      entityId: message.id,
      after: {
        status: determination.status,
        resolvedVehicleId: determination.resolvedVehicle?.id ?? null,
        confidence: determination.confidence,
      },
      requestId: input.requestId,
    });
  });

  return { conversationId: input.conversationId, messageId: message.id, determination };
}
