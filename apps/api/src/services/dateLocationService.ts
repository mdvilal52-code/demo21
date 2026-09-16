import { DateLocationExtractionOrchestrator } from '@ai-concierge/ai';
import {
  createDateLocationExtraction,
  findLatestMessageForConversation,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, type TenantId } from '@ai-concierge/domain';
import type { ExtractDatesLocationResponse } from '@ai-concierge/contracts';

export interface DateLocationServiceDeps {
  prisma: PrismaClient;
  orchestrator: DateLocationExtractionOrchestrator;
}

export interface ExtractDatesLocationInput {
  tenantId: TenantId;
  conversationId: string;
  requestId: string;
}

/**
 * Step 2 — Extract Dates & Location. Input is a Phase 1 conversation's
 * latest message (already validated at ingestion); this never accepts raw
 * customer text directly. AI proposes (the orchestrator's Date/Location
 * extraction services); deterministic domain logic verifies
 * (TemporalValidationService, inside the orchestrator) before anything is
 * persisted or returned.
 */
export async function extractDatesAndLocation(
  deps: DateLocationServiceDeps,
  input: ExtractDatesLocationInput,
): Promise<ExtractDatesLocationResponse> {
  const message = await findLatestMessageForConversation(
    deps.prisma,
    input.tenantId,
    input.conversationId,
  );
  if (!message) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }

  const extraction = await deps.orchestrator.extract(message.content);

  await deps.prisma.$transaction(async (tx) => {
    await createDateLocationExtraction(tx, {
      tenantId: input.tenantId,
      messageId: message.id,
      result: extraction,
    });

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: input.tenantId,
      actor: 'system:date-location-extraction',
      action: 'dates_location.extracted',
      entityType: 'Message',
      entityId: message.id,
      after: {
        pickupDate: extraction.pickupDate,
        returnDate: extraction.returnDate,
        validationErrorCount: extraction.validationErrors.length,
      },
      requestId: input.requestId,
    });
  });

  return { conversationId: input.conversationId, messageId: message.id, extraction };
}
