import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@ai-concierge/domain';

const mocks = vi.hoisted(() => ({
  findConversationById: vi.fn(),
  findLatestMessageForConversation: vi.fn(),
  findLatestVehicleDeterminationForMessage: vi.fn(),
  findLatestDateLocationExtractionForMessage: vi.fn(),
  createAvailabilityCheck: vi.fn(),
  auditRecord: vi.fn(),
  placeHold: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  findConversationById: mocks.findConversationById,
  findLatestMessageForConversation: mocks.findLatestMessageForConversation,
  findLatestVehicleDeterminationForMessage: mocks.findLatestVehicleDeterminationForMessage,
  findLatestDateLocationExtractionForMessage: mocks.findLatestDateLocationExtractionForMessage,
  createAvailabilityCheck: mocks.createAvailabilityCheck,
  PrismaAuditWriter: class {
    record = mocks.auditRecord;
  },
}));

const { checkAvailability } = await import('./availabilityService.js');

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const VEHICLE_ID = '11111111-1111-1111-1111-111111111111';
const MESSAGE = { id: 'msg-1' };
const CONVERSATION = { id: 'conv-1' };

const inOneWeek = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const inTenDays = () => new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
const lastWeek = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

function makeDeps() {
  const prisma = { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})) };
  const reservationLockService = { placeHold: mocks.placeHold };
  return { prisma, reservationLockService } as never;
}

function resolvedVehicleRow() {
  return { status: 'RESOLVED', resolvedVehicleId: VEHICLE_ID };
}

function resolvedDatesRow() {
  return { pickupDate: inOneWeek(), returnDate: inTenDays() };
}

describe('checkAvailability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findConversationById.mockResolvedValue(CONVERSATION);
    mocks.findLatestMessageForConversation.mockResolvedValue(MESSAGE);
  });

  it('throws NOT_FOUND when the conversation has no message', async () => {
    mocks.findLatestMessageForConversation.mockResolvedValue(null);
    await expect(
      checkAvailability(makeDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        requestId: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws VALIDATION_FAILED when Step 3 has not resolved a vehicle yet', async () => {
    mocks.findLatestVehicleDeterminationForMessage.mockResolvedValue(null);
    mocks.findLatestDateLocationExtractionForMessage.mockResolvedValue(resolvedDatesRow());

    await expect(
      checkAvailability(makeDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        requestId: 'r1',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'VEHICLE_NOT_RESOLVED' },
    });
  });

  it('throws VALIDATION_FAILED when the vehicle determination needs clarification, not RESOLVED', async () => {
    mocks.findLatestVehicleDeterminationForMessage.mockResolvedValue({
      status: 'NEEDS_CLARIFICATION',
      resolvedVehicleId: null,
    });
    mocks.findLatestDateLocationExtractionForMessage.mockResolvedValue(resolvedDatesRow());

    await expect(
      checkAvailability(makeDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        requestId: 'r1',
      }),
    ).rejects.toMatchObject({ details: { code: 'VEHICLE_NOT_RESOLVED' } });
  });

  it('throws VALIDATION_FAILED when Step 2 has not resolved dates yet', async () => {
    mocks.findLatestVehicleDeterminationForMessage.mockResolvedValue(resolvedVehicleRow());
    mocks.findLatestDateLocationExtractionForMessage.mockResolvedValue(null);

    await expect(
      checkAvailability(makeDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        requestId: 'r1',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'DATES_NOT_RESOLVED' },
    });
  });

  it('throws VALIDATION_FAILED when the resolved pickup date has since gone stale (now in the past)', async () => {
    mocks.findLatestVehicleDeterminationForMessage.mockResolvedValue(resolvedVehicleRow());
    mocks.findLatestDateLocationExtractionForMessage.mockResolvedValue({
      pickupDate: lastWeek(),
      returnDate: inOneWeek(),
    });

    await expect(
      checkAvailability(makeDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        requestId: 'r1',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'PICKUP_DATE_NOW_IN_PAST' },
    });
    expect(mocks.placeHold).not.toHaveBeenCalled();
  });

  it('calls placeHold and returns a HELD result on success, persisting a check + audit event', async () => {
    mocks.findLatestVehicleDeterminationForMessage.mockResolvedValue(resolvedVehicleRow());
    mocks.findLatestDateLocationExtractionForMessage.mockResolvedValue(resolvedDatesRow());
    mocks.placeHold.mockResolvedValue({
      outcome: 'HELD',
      source: 'database-fleet',
      hold: {
        id: 'hold-1',
        vehicleId: VEHICLE_ID,
        pickupDate: inOneWeek().toISOString(),
        returnDate: inTenDays().toISOString(),
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
    });

    const response = await checkAvailability(makeDeps(), {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      requestId: 'r1',
    });

    expect(response.availability.status).toBe('HELD');
    expect(response.availability.hold?.id).toBe('hold-1');
    expect(mocks.createAvailabilityCheck).toHaveBeenCalledTimes(1);
    expect(mocks.auditRecord).toHaveBeenCalledTimes(1);
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'availability.checked', entityId: MESSAGE.id }),
    );
  });

  it.each([
    ['UNAVAILABLE', 'UNAVAILABLE'],
    ['MAINTENANCE', 'MAINTENANCE'],
  ] as const)(
    'maps ReservationLockService outcome %s to InventoryStatus %s',
    async (outcome, expected) => {
      mocks.findLatestVehicleDeterminationForMessage.mockResolvedValue(resolvedVehicleRow());
      mocks.findLatestDateLocationExtractionForMessage.mockResolvedValue(resolvedDatesRow());
      mocks.placeHold.mockResolvedValue({ outcome, source: 'database-fleet' });

      const response = await checkAvailability(makeDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        requestId: 'r1',
      });
      expect(response.availability.status).toBe(expected);
      expect(response.availability.hold).toBeNull();
    },
  );

  it('maps an UNKNOWN outcome through with its reason and retryable flag, never a fake status', async () => {
    mocks.findLatestVehicleDeterminationForMessage.mockResolvedValue(resolvedVehicleRow());
    mocks.findLatestDateLocationExtractionForMessage.mockResolvedValue(resolvedDatesRow());
    mocks.placeHold.mockResolvedValue({
      outcome: 'UNKNOWN',
      reason: 'fleet API timed out',
      retryable: true,
      source: 'external-fleet-api',
    });

    const response = await checkAvailability(makeDeps(), {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      requestId: 'r1',
    });
    expect(response.availability).toMatchObject({
      status: 'UNKNOWN',
      reason: 'fleet API timed out',
      retryable: true,
    });
  });

  it('maps ALREADY_HELD (a confirmed replay) to BOOKED when the hold status is CONFIRMED', async () => {
    mocks.findLatestVehicleDeterminationForMessage.mockResolvedValue(resolvedVehicleRow());
    mocks.findLatestDateLocationExtractionForMessage.mockResolvedValue(resolvedDatesRow());
    mocks.placeHold.mockResolvedValue({
      outcome: 'ALREADY_HELD',
      source: 'idempotent-replay',
      hold: {
        id: 'hold-1',
        vehicleId: VEHICLE_ID,
        pickupDate: inOneWeek().toISOString(),
        returnDate: inTenDays().toISOString(),
        status: 'CONFIRMED',
        expiresAt: null,
      },
    });

    const response = await checkAvailability(makeDeps(), {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      requestId: 'r1',
    });
    expect(response.availability.status).toBe('BOOKED');
  });

  it('derives a deterministic idempotency key from message + vehicle + dates', async () => {
    mocks.findLatestVehicleDeterminationForMessage.mockResolvedValue(resolvedVehicleRow());
    const dates = resolvedDatesRow();
    mocks.findLatestDateLocationExtractionForMessage.mockResolvedValue(dates);
    mocks.placeHold.mockResolvedValue({ outcome: 'UNAVAILABLE', source: 'database-fleet' });

    await checkAvailability(makeDeps(), {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      requestId: 'r1',
    });

    expect(mocks.placeHold).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `availability-check:${MESSAGE.id}:${VEHICLE_ID}:${dates.pickupDate.toISOString()}:${dates.returnDate.toISOString()}`,
      }),
    );
  });

  it('is exported as AppError-safe: precondition failures are always AppError instances', async () => {
    mocks.findLatestVehicleDeterminationForMessage.mockResolvedValue(null);
    mocks.findLatestDateLocationExtractionForMessage.mockResolvedValue(null);
    try {
      await checkAvailability(makeDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        requestId: 'r1',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
    }
  });
});
