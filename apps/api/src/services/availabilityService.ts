import { AvailabilityRequestError, validateAvailabilityRequest } from '@ai-concierge/ai';
import {
  createAvailabilityCheck,
  findConversationById,
  findLatestDateLocationExtractionForMessage,
  findLatestMessageForConversation,
  findLatestVehicleDeterminationForMessage,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import {
  AppError,
  AvailabilityErrorCode,
  InventoryStatus,
  type AvailabilityCheckResult,
  type TenantId,
} from '@ai-concierge/domain';
import type { CheckAvailabilityResponse } from '@ai-concierge/contracts';
import type { PlaceHoldResult, ReservationLockService } from './reservationLockService.js';

export interface AvailabilityServiceDeps {
  prisma: PrismaClient;
  reservationLockService: ReservationLockService;
}

export interface CheckAvailabilityInput {
  tenantId: TenantId;
  conversationId: string;
  requestId: string;
}

const MODEL_METADATA = {
  engine: 'reservation-lock-service',
  version: '1.0.0',
  deterministic: false, // depends on concurrent DB/fleet state at the instant it runs — never a pure function of its inputs alone
} as const;

function toAvailabilityCheckResult(
  result: PlaceHoldResult,
  vehicleId: string,
  pickupAt: Date,
  returnAt: Date,
  checkedAt: Date,
): AvailabilityCheckResult {
  const base = {
    vehicleId,
    pickupDate: pickupAt.toISOString(),
    returnDate: returnAt.toISOString(),
    checkedAt: checkedAt.toISOString(),
    modelMetadata: MODEL_METADATA,
  };

  switch (result.outcome) {
    case 'HELD':
    case 'ALREADY_HELD':
      return {
        ...base,
        status: result.hold.status === 'CONFIRMED' ? InventoryStatus.BOOKED : InventoryStatus.HELD,
        hold: result.hold,
        source: result.source,
        reason: null,
        retryable: false,
      };
    case 'UNAVAILABLE':
      return {
        ...base,
        status: InventoryStatus.UNAVAILABLE,
        hold: null,
        source: result.source,
        reason: 'No units available for the requested dates',
        retryable: false,
      };
    case 'MAINTENANCE':
      return {
        ...base,
        status: InventoryStatus.MAINTENANCE,
        hold: null,
        source: result.source,
        reason: 'This vehicle class is currently under maintenance',
        retryable: false,
      };
    case 'UNKNOWN':
      return {
        ...base,
        status: InventoryStatus.UNKNOWN,
        hold: null,
        source: result.source,
        reason: result.reason,
        retryable: result.retryable,
      };
  }
}

/**
 * Step 6 — Availability. Input is a conversation's already-resolved Step 3
 * vehicle + Step 2 dates (never raw text, never a request body) — matching
 * Steps 2-4's convention exactly. Always calls
 * `ReservationLockService.placeHold` (the authoritative, lock-protected
 * claim), never a non-committal preview alone, so a HELD/BOOKED response is
 * always backed by a real row, never a guess.
 */
export async function checkAvailability(
  deps: AvailabilityServiceDeps,
  input: CheckAvailabilityInput,
): Promise<CheckAvailabilityResponse> {
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

  if (!vehicleRow || vehicleRow.status !== 'RESOLVED' || !vehicleRow.resolvedVehicleId) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Vehicle has not been resolved yet for this conversation',
      {
        details: { code: AvailabilityErrorCode.VEHICLE_NOT_RESOLVED },
      },
    );
  }
  if (!dateLocationRow?.pickupDate || !dateLocationRow.returnDate) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Pickup/return dates have not been resolved yet for this conversation',
      { details: { code: AvailabilityErrorCode.DATES_NOT_RESOLVED } },
    );
  }

  const vehicleId = vehicleRow.resolvedVehicleId;
  const pickupAt = dateLocationRow.pickupDate;
  const returnAt = dateLocationRow.returnDate;

  // Deterministic per (message, vehicle, dates): a retry of the exact same
  // request replays the same hold; re-running Step 3 to change vehicles, or
  // Step 2 to change dates, is a genuinely new request and gets a new key.
  const idempotencyKey = `availability-check:${message.id}:${vehicleId}:${pickupAt.toISOString()}:${returnAt.toISOString()}`;

  let result;
  try {
    // A fast, specific pre-check (no DB write) so a stale date range fails
    // immediately with a clear code; `placeHold` itself re-validates the
    // exact same thing as the authoritative backstop (see its own doc) —
    // both throw `AvailabilityRequestError`, caught here identically.
    validateAvailabilityRequest(pickupAt, returnAt, new Date());
    result = await deps.reservationLockService.placeHold({
      tenantId: input.tenantId,
      vehicleId,
      pickupAt,
      returnAt,
      idempotencyKey,
      requestedBy: `system:availability-check:${input.requestId}`,
    });
  } catch (error) {
    if (error instanceof AvailabilityRequestError) {
      throw new AppError('VALIDATION_FAILED', error.message, { details: { code: error.code } });
    }
    throw error;
  }

  const availability = toAvailabilityCheckResult(result, vehicleId, pickupAt, returnAt, new Date());

  await deps.prisma.$transaction(async (tx) => {
    await createAvailabilityCheck(tx, {
      tenantId: input.tenantId,
      messageId: message.id,
      result: availability,
    });

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: input.tenantId,
      actor: 'system:availability-check',
      action: 'availability.checked',
      entityType: 'Message',
      entityId: message.id,
      after: { status: availability.status, holdId: availability.hold?.id ?? null },
      requestId: input.requestId,
    });
  });

  return { conversationId: input.conversationId, messageId: message.id, availability };
}
