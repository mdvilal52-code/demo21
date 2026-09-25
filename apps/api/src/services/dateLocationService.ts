import { DateLocationExtractionOrchestrator } from '@ai-concierge/ai';
import {
  createDateLocationExtraction,
  findLatestMessageForConversation,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, type TenantId } from '@ai-concierge/domain';
import type { ExtractDatesLocationResponse } from '@ai-concierge/contracts';
import { buildConversationTranscript } from './conversationTranscript.js';

export interface DateLocationServiceDeps {
  prisma: PrismaClient;
  orchestrator: DateLocationExtractionOrchestrator;
}

export interface ExtractDatesLocationInput {
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
 * Step 2 — Extract Dates & Location. Input is the conversation's accumulated
 * transcript up to and including its latest message (already validated at
 * ingestion), not raw customer text passed directly — so a follow-up turn
 * that doesn't restate an earlier date/location still resolves against what
 * was already said. AI proposes (the orchestrator's Date/Location
 * extraction services); deterministic domain logic verifies
 * (TemporalValidationService, inside the orchestrator) before anything is
 * persisted or returned. The result is still recorded against the latest
 * message, matching Step 4's lookup convention.
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

  const transcript =
    input.precomputedTranscript ??
    (await buildConversationTranscript(deps.prisma, input.tenantId, input.conversationId));
  const extraction = await deps.orchestrator.extract(transcript);

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
