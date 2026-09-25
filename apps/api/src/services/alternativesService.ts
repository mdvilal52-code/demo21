import {
  buildAlternativeReason,
  type AlternativeRecommendationOrchestrator,
} from '@ai-concierge/ai';
import {
  createAlternativeRecommendation,
  findConversationById,
  findLatestDateLocationExtractionForMessage,
  findLatestMessageForConversation,
  findLatestVehicleDeterminationForMessage,
  toDomainVehicle,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import {
  AlternativeRecommendationStatus,
  AlternativesErrorCode,
  AppError,
  recommendAlternativesResultSchema,
  type AlternativeCandidate,
  type RecommendAlternativesResult,
  type TenantId,
  type Vehicle,
} from '@ai-concierge/domain';
import type { RecommendAlternativesResponse } from '@ai-concierge/contracts';
import type { RankedCandidate } from '@ai-concierge/ai';

export interface AlternativesServiceDeps {
  prisma: PrismaClient;
  orchestrator: AlternativeRecommendationOrchestrator;
}

export interface RecommendAlternativesInput {
  tenantId: TenantId;
  conversationId: string;
  requestId: string;
}

const MODEL_METADATA = {
  engine: 'alternative-recommendation-orchestrator',
  version: '1.0.0',
  deterministic: true,
} as const;

function toAlternativeCandidate(requested: Vehicle, ranked: RankedCandidate): AlternativeCandidate {
  return {
    vehicle: ranked.vehicle,
    availabilitySource: ranked.availabilitySource,
    availabilityCheckedAt: ranked.availabilityCheckedAt.toISOString(),
    priceDifference: ranked.ranking.priceDifference,
    currency: ranked.ranking.currency,
    reason: buildAlternativeReason(requested, ranked),
  };
}

/**
 * Step 7 — Alternatives. Input is a conversation's already-resolved Step 3
 * vehicle + Step 2 dates (never raw text, never a request body) — same
 * convention as Steps 2-6. Never places a hold for any candidate ("human
 * decision remains available"): only `ReservationLockService.placeHold`
 * (Step 6's own endpoint) may do that, once a human/customer picks one.
 */
export async function recommendAlternatives(
  deps: AlternativesServiceDeps,
  input: RecommendAlternativesInput,
): Promise<RecommendAlternativesResponse> {
  const [conversation, message] = await Promise.all([
    findConversationById(deps.prisma, input.tenantId, input.conversationId),
    findLatestMessageForConversation(deps.prisma, input.tenantId, input.conversationId),
  ]);
  if (!conversation || !message) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }

  const [vehicleRow, dateLocationRow] = await Promise.all([
    findLatestVehicleDeterminationForMessage(deps.prisma, input.tenantId, message.id),
    findLatestDateLocationExtractionForMessage(deps.prisma, input.tenantId, message.id),
  ]);

  if (!vehicleRow || vehicleRow.status !== 'RESOLVED' || !vehicleRow.resolvedVehicle) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Vehicle has not been resolved yet for this conversation',
      { details: { code: AlternativesErrorCode.VEHICLE_NOT_RESOLVED } },
    );
  }
  if (!dateLocationRow?.pickupDate || !dateLocationRow.returnDate) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Pickup/return dates have not been resolved yet for this conversation',
      { details: { code: AlternativesErrorCode.DATES_NOT_RESOLVED } },
    );
  }

  const requestedVehicle = toDomainVehicle(vehicleRow.resolvedVehicle);

  const ranking = await deps.orchestrator.recommend({
    tenantId: input.tenantId,
    requestedVehicle,
    pickupAt: dateLocationRow.pickupDate,
    returnAt: dateLocationRow.returnDate,
  });

  const primary = ranking.qualifying[0]
    ? toAlternativeCandidate(requestedVehicle, ranking.qualifying[0])
    : null;
  const secondary = ranking.qualifying[1]
    ? toAlternativeCandidate(requestedVehicle, ranking.qualifying[1])
    : null;

  const result: RecommendAlternativesResult = recommendAlternativesResultSchema.parse({
    status: primary
      ? AlternativeRecommendationStatus.ALTERNATIVES_FOUND
      : AlternativeRecommendationStatus.NO_ALTERNATIVES,
    requestedVehicleId: requestedVehicle.id,
    primary,
    secondary,
    consideredCount: ranking.consideredCount,
    modelMetadata: MODEL_METADATA,
    checkedAt: new Date().toISOString(),
  });

  await deps.prisma.$transaction(async (tx) => {
    await createAlternativeRecommendation(tx, {
      tenantId: input.tenantId,
      messageId: message.id,
      result,
    });

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: input.tenantId,
      actor: 'system:alternatives',
      action: 'alternatives.recommended',
      entityType: 'Message',
      entityId: message.id,
      after: {
        status: result.status,
        primaryVehicleId: result.primary?.vehicle.id ?? null,
        secondaryVehicleId: result.secondary?.vehicle.id ?? null,
      },
      requestId: input.requestId,
    });
  });

  return { conversationId: input.conversationId, messageId: message.id, alternatives: result };
}
