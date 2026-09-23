import type { EligibilityCheckContext, EligibilityOrchestrator } from '@ai-concierge/ai';
import {
  createEligibilityDecision,
  findActiveEligibilityPolicy,
  findApplicableEligibilityExceptions,
  findConversationById,
  findLatestDateLocationExtractionForMessage,
  findLatestMessageForConversation,
  findLatestVehicleDeterminationForMessage,
  toDomainVehicle,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, type NormalizedLocation, type TenantId } from '@ai-concierge/domain';
import type { CheckEligibilityBody, CheckEligibilityResponse } from '@ai-concierge/contracts';

export interface EligibilityServiceDeps {
  prisma: PrismaClient;
  orchestrator: EligibilityOrchestrator;
}

export interface CheckEligibilityInput {
  tenantId: TenantId;
  conversationId: string;
  requestId: string;
  body: CheckEligibilityBody;
}

/**
 * Step 5 — Eligibility. Customer/driver data is validated request-boundary
 * input (this step is the first to collect it — never re-derived from raw
 * text); vehicle/dates/location are read from whatever Steps 2-3 already
 * resolved for the conversation's latest message, the same "read what was
 * already verified, never re-derive" convention `checkMissingInfo` uses.
 */
export async function checkEligibility(
  deps: EligibilityServiceDeps,
  input: CheckEligibilityInput,
): Promise<CheckEligibilityResponse> {
  const [conversation, message] = await Promise.all([
    findConversationById(deps.prisma, input.tenantId, input.conversationId),
    findLatestMessageForConversation(deps.prisma, input.tenantId, input.conversationId),
  ]);
  if (!conversation || !message) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }

  const [dateLocationRow, vehicleRow, policy] = await Promise.all([
    findLatestDateLocationExtractionForMessage(deps.prisma, input.tenantId, message.id),
    findLatestVehicleDeterminationForMessage(deps.prisma, input.tenantId, message.id),
    findActiveEligibilityPolicy(deps.prisma, input.tenantId),
  ]);

  if (!policy) {
    throw new AppError('NOT_CONFIGURED', 'No eligibility policy is configured for this tenant');
  }

  const exceptions = await findApplicableEligibilityExceptions(deps.prisma, input.tenantId, {
    customerRef: conversation.customerRef,
    nationality: input.body.customer.nationality,
  });

  const context: EligibilityCheckContext = {
    customer: input.body.customer,
    additionalDrivers: input.body.additionalDrivers,
    customerRef: conversation.customerRef,
    vehicle: vehicleRow?.resolvedVehicle ? toDomainVehicle(vehicleRow.resolvedVehicle) : null,
    pickupDate: dateLocationRow?.pickupDate?.toISOString() ?? null,
    returnDate: dateLocationRow?.returnDate?.toISOString() ?? null,
    pickupLocation: (dateLocationRow?.pickupLocation as NormalizedLocation | null) ?? null,
    dropoffLocation: (dateLocationRow?.dropoffLocation as NormalizedLocation | null) ?? null,
    now: new Date(),
  };

  const decision = deps.orchestrator.evaluate(context, policy, exceptions);

  await deps.prisma.$transaction(async (tx) => {
    await createEligibilityDecision(tx, {
      tenantId: input.tenantId,
      messageId: message.id,
      result: decision,
    });

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: input.tenantId,
      actor: 'system:eligibility-check',
      action: 'eligibility.decided',
      entityType: 'Message',
      entityId: message.id,
      after: {
        status: decision.status,
        failedRuleCount: decision.ruleResults.filter((result) => result.outcome === 'FAIL').length,
        exceptionsApplied: decision.exceptionsApplied.length,
      },
      requestId: input.requestId,
    });
  });

  return { conversationId: input.conversationId, messageId: message.id, decision };
}
