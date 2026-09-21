import type { VehicleDeterminationOrchestrator } from '@ai-concierge/ai';
import {
  createVehicleDetermination,
  findMessagesForConversation,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, type TenantId } from '@ai-concierge/domain';
import type { DetermineVehicleResponse } from '@ai-concierge/contracts';
import { buildAccumulatedTranscript } from '../lib/conversationTranscript.js';

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
 * Step 3 — Determine Vehicle. Input is a Phase 1 conversation's accumulated
 * transcript (already validated at ingestion, message by message); this
 * never accepts raw customer text directly. Extracting from every message
 * so far — not just the latest — means a vehicle named in an earlier turn
 * is still picked up when a later turn only adds dates or a location; for a
 * single-message conversation this is identical to extracting from that one
 * message. AI proposes (`VehicleIntentService`, inside the orchestrator);
 * deterministic domain logic verifies against the real fleet
 * (`VehicleCatalogService` + `VehicleValidationService`) before anything is
 * persisted or returned.
 */
export async function determineVehicle(
  deps: VehicleServiceDeps,
  input: DetermineVehicleInput,
): Promise<DetermineVehicleResponse> {
  const messages = await findMessagesForConversation(
    deps.prisma,
    input.tenantId,
    input.conversationId,
  );
  const message = messages[messages.length - 1];
  if (!message) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }

  const determination = await deps.orchestrator.determine(buildAccumulatedTranscript(messages), {
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
