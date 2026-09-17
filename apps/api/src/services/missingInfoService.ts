import type {
  DateLocationSnapshot,
  IntentSnapshot,
  MissingInfoOrchestrator,
  VehicleSnapshot,
} from '@ai-concierge/ai';
import {
  findConversationById,
  findLatestDateLocationExtractionForMessage,
  findLatestIntentRecordForMessage,
  findLatestMessageForConversation,
  findLatestVehicleDeterminationForMessage,
  createMissingInfoCheck,
  toDomainVehicle,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import {
  AppError,
  type Ambiguity,
  type NormalizedLocation,
  type TenantId,
  type ValidationIssue,
  type VehicleAmbiguity,
  type VehicleValidationError,
} from '@ai-concierge/domain';
import type { CheckMissingInfoResponse } from '@ai-concierge/contracts';

export interface MissingInfoServiceDeps {
  prisma: PrismaClient;
  orchestrator: MissingInfoOrchestrator;
}

export interface CheckMissingInfoInput {
  tenantId: TenantId;
  conversationId: string;
  requestId: string;
}

/**
 * Step 4 — Ask Missing Information. Reads whatever Steps 1-3 already
 * resolved for this conversation's latest message (never raw text) and
 * deterministically decides what's still needed. Input is a conversation, not
 * a body — matching Steps 2-3's convention exactly.
 */
export async function checkMissingInfo(
  deps: MissingInfoServiceDeps,
  input: CheckMissingInfoInput,
): Promise<CheckMissingInfoResponse> {
  const [conversation, message] = await Promise.all([
    findConversationById(deps.prisma, input.tenantId, input.conversationId),
    findLatestMessageForConversation(deps.prisma, input.tenantId, input.conversationId),
  ]);
  if (!conversation || !message) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }

  const [intentRow, dateLocationRow, vehicleRow] = await Promise.all([
    findLatestIntentRecordForMessage(deps.prisma, input.tenantId, message.id),
    findLatestDateLocationExtractionForMessage(deps.prisma, input.tenantId, message.id),
    findLatestVehicleDeterminationForMessage(deps.prisma, input.tenantId, message.id),
  ]);

  const intent: IntentSnapshot | null = intentRow
    ? {
        intentType: intentRow.intentType,
        promptInjectionDetected: (intentRow.flags as { promptInjectionDetected: boolean })
          .promptInjectionDetected,
      }
    : null;

  const dateLocation: DateLocationSnapshot | null = dateLocationRow
    ? {
        pickupDate: dateLocationRow.pickupDate?.toISOString() ?? null,
        returnDate: dateLocationRow.returnDate?.toISOString() ?? null,
        pickupLocation: dateLocationRow.pickupLocation as NormalizedLocation | null,
        dropoffLocation: dateLocationRow.dropoffLocation as NormalizedLocation | null,
        ambiguities: dateLocationRow.ambiguities as unknown as Ambiguity[],
        validationErrors: dateLocationRow.validationErrors as unknown as ValidationIssue[],
        promptInjectionDetected: (dateLocationRow.flags as { promptInjectionDetected: boolean })
          .promptInjectionDetected,
      }
    : null;

  const vehicle: VehicleSnapshot | null = vehicleRow
    ? {
        status: vehicleRow.status,
        resolvedVehicle: vehicleRow.resolvedVehicle
          ? toDomainVehicle(vehicleRow.resolvedVehicle)
          : null,
        ambiguities: vehicleRow.ambiguities as unknown as VehicleAmbiguity[],
        validationErrors: vehicleRow.validationErrors as unknown as VehicleValidationError[],
        promptInjectionDetected: (vehicleRow.flags as { promptInjectionDetected: boolean })
          .promptInjectionDetected,
      }
    : null;

  const missingInfo = deps.orchestrator.evaluate({
    intent,
    dateLocation,
    vehicle,
    conversationCreatedAt: conversation.createdAt,
    now: new Date(),
  });

  await deps.prisma.$transaction(async (tx) => {
    await createMissingInfoCheck(tx, {
      tenantId: input.tenantId,
      messageId: message.id,
      result: missingInfo,
    });

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: input.tenantId,
      actor: 'system:missing-info-check',
      action: 'missing_info.checked',
      entityType: 'Message',
      entityId: message.id,
      after: {
        status: missingInfo.status,
        missingFieldCount: missingInfo.missingFields.length,
      },
      requestId: input.requestId,
    });
  });

  return { conversationId: input.conversationId, messageId: message.id, missingInfo };
}
