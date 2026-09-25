import type { VehicleDeterminationOrchestrator } from '@ai-concierge/ai';
import {
  createVehicleDetermination,
  findLatestMessageForConversation,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, type TenantId } from '@ai-concierge/domain';
import type { DetermineVehicleResponse } from '@ai-concierge/contracts';
import { buildConversationTranscript } from './conversationTranscript.js';

export interface VehicleServiceDeps {
  prisma: PrismaClient;
  orchestrator: VehicleDeterminationOrchestrator;
}

export interface DetermineVehicleInput {
  tenantId: TenantId;
  conversationId: string;
  requestId: string;
  /**
   * Reuse a transcript the caller already fetched (e.g. the WhatsApp channel
   * fetches it once and shares it across Steps 2-3 plus the reply generator)
   * instead of querying the same message history again. REST callers omit
   * this and get a freshly-fetched transcript, same as before.
   */
  precomputedTranscript?: string;
}

/**
 * Step 3 — Determine Vehicle. Input is the conversation's accumulated
 * transcript up to and including its latest message (already validated at
 * ingestion), not raw customer text passed directly — so "the same car" or a
 * follow-up that doesn't restate the vehicle still resolves against what was
 * already said. AI proposes (`VehicleIntentService`, inside the
 * orchestrator); deterministic domain logic verifies against the real fleet
 * (`VehicleCatalogService` + `VehicleValidationService`) before anything is
 * persisted or returned. The result is still recorded against the latest
 * message, matching Step 4's lookup convention.
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

  const transcript =
    input.precomputedTranscript ??
    (await buildConversationTranscript(deps.prisma, input.tenantId, input.conversationId));
  const determination = await deps.orchestrator.determine(transcript, {
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
