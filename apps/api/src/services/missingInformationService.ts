import type { MissingInformationEngine } from '@ai-concierge/ai';
import {
  findConversationWithLatestMessage,
  findLatestIntentRecordForConversation,
  findLatestDateLocationExtractionForConversation,
  findMissingInformationState,
  hasVehicleDeterminationForConversation,
  saveMissingInformationState,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, MAX_MISSING_INFO_TURNS, type TenantId } from '@ai-concierge/domain';
import type { CollectMissingInformationResponse } from '@ai-concierge/contracts';

export interface MissingInformationServiceDeps {
  prisma: PrismaClient;
  engine: MissingInformationEngine;
}

export interface CollectMissingInformationInput {
  tenantId: TenantId;
  conversationId: string;
  requestId: string;
}

/**
 * Step 4 — Ask Missing Information. Input is the conversation's latest
 * message (never raw request-body text, same convention as Steps 2-3) plus
 * Steps 1-3's already-persisted results, read fresh on every call so a
 * customer's correction to an earlier step is picked up automatically.
 * Unlike Steps 2-3, this also carries state across turns (`ConversationState`,
 * via `MissingInformationState`) and enforces the dependency chain
 * (1 intent -> 2 dates/location -> 3 vehicle) and an abuse-protection turn
 * cap explicitly, since the engine itself never throws.
 *
 * This endpoint takes no body, so a retried request is identical to the
 * original by construction; `lastProcessedMessageId` is how that retry is
 * recognized (same message as last time -> no new information could
 * possibly exist) and treated as a no-op replay: `buildResultFromState`
 * reconstructs the current view from what's already persisted instead of
 * reprocessing the message a second time (reprocessing against the
 * already-updated pending-questions state could misread the original
 * message as a reply to a question that same message only just caused to
 * be asked) — nothing is persisted or audited again, and it never counts
 * against the turn cap.
 */
export async function collectMissingInformation(
  deps: MissingInformationServiceDeps,
  input: CollectMissingInformationInput,
): Promise<CollectMissingInformationResponse> {
  // None of these five reads depends on another's result — issued together so this
  // endpoint pays for one round trip instead of three sequential ones.
  const [conversationData, step1, step2, step3Done, priorState] = await Promise.all([
    findConversationWithLatestMessage(deps.prisma, input.tenantId, input.conversationId),
    findLatestIntentRecordForConversation(deps.prisma, input.tenantId, input.conversationId),
    findLatestDateLocationExtractionForConversation(
      deps.prisma,
      input.tenantId,
      input.conversationId,
    ),
    hasVehicleDeterminationForConversation(deps.prisma, input.tenantId, input.conversationId),
    findMissingInformationState(deps.prisma, input.tenantId, input.conversationId),
  ]);

  if (!conversationData) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }
  const { channel, message } = conversationData;

  if (!step1 || !step2 || !step3Done) {
    const missingSteps: string[] = [];
    if (!step1) missingSteps.push('intent (Step 1)');
    if (!step2) missingSteps.push('dates/location (Step 2)');
    if (!step3Done) missingSteps.push('vehicle (Step 3)');
    throw new AppError(
      'CONFLICT',
      `Step 4 requires Steps 1-3 to complete first for this conversation; still missing: ${missingSteps.join(', ')}`,
      { details: { missingSteps } },
    );
  }

  const isReplay = priorState !== null && priorState.lastProcessedMessageId === message.id;

  if (!isReplay && priorState && priorState.turnCount >= MAX_MISSING_INFO_TURNS) {
    throw new AppError(
      'RATE_LIMITED',
      'This conversation has reached the maximum number of missing-information turns',
      { details: { turnCount: priorState.turnCount, max: MAX_MISSING_INFO_TURNS } },
    );
  }

  const stepContext = {
    step1: { driverRequired: step1.entities.driverRequired, language: step1.entities.language },
    step2: { pickupLocation: step2.pickupLocation, dropoffLocation: step2.dropoffLocation },
    channel,
  };

  if (isReplay) {
    const result = deps.engine.buildResultFromState(priorState, stepContext);
    return { conversationId: input.conversationId, messageId: message.id, result };
  }

  const { result, nextStateData } = deps.engine.processTurn({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: message.id,
    latestMessageText: message.content,
    priorState,
    ...stepContext,
  });

  await deps.prisma.$transaction(async (tx) => {
    await saveMissingInformationState(tx, nextStateData, priorState ? priorState.version : null);

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: input.tenantId,
      actor: 'system:missing-information',
      action: 'missing_information.evaluated',
      entityType: 'Conversation',
      entityId: input.conversationId,
      // Counts only — answer values (flight number, address, contact, ...) may carry PII.
      after: {
        status: result.status,
        missingFieldCount: result.missingFields.length,
        answeredFieldCount: result.answers.length,
        correctionCount: result.corrections.length,
        contradictionCount: result.contradictions.length,
      },
      requestId: input.requestId,
    });
  });

  return { conversationId: input.conversationId, messageId: message.id, result };
}
