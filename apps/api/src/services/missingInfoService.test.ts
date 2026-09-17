import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@ai-concierge/domain';

const mocks = vi.hoisted(() => ({
  findConversationById: vi.fn(),
  findLatestMessageForConversation: vi.fn(),
  findLatestIntentRecordForMessage: vi.fn(),
  findLatestDateLocationExtractionForMessage: vi.fn(),
  findLatestVehicleDeterminationForMessage: vi.fn(),
  createMissingInfoCheck: vi.fn(),
  toDomainVehicle: vi.fn(),
  auditRecord: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  findConversationById: mocks.findConversationById,
  findLatestMessageForConversation: mocks.findLatestMessageForConversation,
  findLatestIntentRecordForMessage: mocks.findLatestIntentRecordForMessage,
  findLatestDateLocationExtractionForMessage: mocks.findLatestDateLocationExtractionForMessage,
  findLatestVehicleDeterminationForMessage: mocks.findLatestVehicleDeterminationForMessage,
  createMissingInfoCheck: mocks.createMissingInfoCheck,
  toDomainVehicle: mocks.toDomainVehicle,
  PrismaAuditWriter: class {
    record = mocks.auditRecord;
  },
}));

const { checkMissingInfo } = await import('./missingInfoService.js');

const fakeMissingInfo = {
  status: 'NEEDS_INFO',
  collected: {
    pickupDate: null,
    returnDate: null,
    pickupLocation: null,
    dropoffLocation: null,
    vehicle: null,
  },
  missingFields: [{ field: 'PICKUP_DATE', reason: 'NOT_PROVIDED' }],
  clarificationPrompt: 'Could you please confirm when you would like to pick up the car?',
  expiresAt: '2026-09-18T00:00:00.000Z',
  flags: { promptInjectionDetectedAnywhere: false },
  modelMetadata: { engine: 'missing-info-evaluator-v1', version: '0.1.0', deterministic: true },
};

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function makeDeps() {
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  };
  const orchestrator = { evaluate: vi.fn().mockReturnValue(fakeMissingInfo) };
  return { prisma, orchestrator } as never;
}

describe('checkMissingInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws NOT_FOUND when the conversation has no message', async () => {
    mocks.findConversationById.mockResolvedValue({ createdAt: new Date() });
    mocks.findLatestMessageForConversation.mockResolvedValue(null);
    await expect(
      checkMissingInfo(makeDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        requestId: 'req-1',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('throws NOT_FOUND when the conversation itself does not exist', async () => {
    mocks.findConversationById.mockResolvedValue(null);
    mocks.findLatestMessageForConversation.mockResolvedValue({ id: 'msg-1', content: 'hi' });
    await expect(
      checkMissingInfo(makeDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        requestId: 'req-1',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('evaluates against the latest per-step records, persists, and audits', async () => {
    const createdAt = new Date('2026-09-16T12:00:00.000Z');
    mocks.findConversationById.mockResolvedValue({ id: 'conv-1', createdAt });
    mocks.findLatestMessageForConversation.mockResolvedValue({
      id: 'msg-1',
      content: 'I want to rent a car',
    });
    mocks.findLatestIntentRecordForMessage.mockResolvedValue({
      intentType: 'BOOKING_REQUEST',
      flags: { promptInjectionDetected: false },
    });
    mocks.findLatestDateLocationExtractionForMessage.mockResolvedValue(null);
    mocks.findLatestVehicleDeterminationForMessage.mockResolvedValue(null);

    const deps = makeDeps();
    const result = await checkMissingInfo(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      requestId: 'req-1',
    });

    const orchestrator = (deps as { orchestrator: { evaluate: ReturnType<typeof vi.fn> } })
      .orchestrator;
    expect(orchestrator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: { intentType: 'BOOKING_REQUEST', promptInjectionDetected: false },
        dateLocation: null,
        vehicle: null,
        conversationCreatedAt: createdAt,
      }),
    );
    expect(mocks.createMissingInfoCheck).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ tenantId: TENANT_ID, messageId: 'msg-1' }),
    );
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'missing_info.checked', entityId: 'msg-1' }),
    );
    expect(result.conversationId).toBe('conv-1');
    expect(result.messageId).toBe('msg-1');
    expect(result.missingInfo).toEqual(fakeMissingInfo);
  });

  it('maps a joined resolvedVehicle row through toDomainVehicle', async () => {
    mocks.findConversationById.mockResolvedValue({ id: 'conv-1', createdAt: new Date() });
    mocks.findLatestMessageForConversation.mockResolvedValue({ id: 'msg-1', content: 'hi' });
    mocks.findLatestIntentRecordForMessage.mockResolvedValue(null);
    mocks.findLatestDateLocationExtractionForMessage.mockResolvedValue(null);
    const rawVehicleRow = { id: 'v1', make: 'Lamborghini' };
    mocks.findLatestVehicleDeterminationForMessage.mockResolvedValue({
      status: 'RESOLVED',
      resolvedVehicle: rawVehicleRow,
      ambiguities: [],
      validationErrors: [],
      flags: { promptInjectionDetected: false },
    });
    mocks.toDomainVehicle.mockReturnValue({ id: 'v1', make: 'Lamborghini', model: 'Urus' });

    const deps = makeDeps();
    await checkMissingInfo(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      requestId: 'req-1',
    });

    expect(mocks.toDomainVehicle).toHaveBeenCalledWith(rawVehicleRow);
    const orchestrator = (deps as { orchestrator: { evaluate: ReturnType<typeof vi.fn> } })
      .orchestrator;
    expect(orchestrator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        vehicle: expect.objectContaining({
          resolvedVehicle: { id: 'v1', make: 'Lamborghini', model: 'Urus' },
        }),
      }),
    );
  });
});
