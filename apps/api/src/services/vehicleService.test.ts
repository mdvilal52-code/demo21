import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@ai-concierge/domain';

const mocks = vi.hoisted(() => ({
  findMessagesForConversation: vi.fn(),
  createVehicleDetermination: vi.fn(),
  auditRecord: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  findMessagesForConversation: mocks.findMessagesForConversation,
  createVehicleDetermination: mocks.createVehicleDetermination,
  PrismaAuditWriter: class {
    record = mocks.auditRecord;
  },
}));

const { determineVehicle } = await import('./vehicleService.js');

const fakeDetermination = {
  status: 'RESOLVED',
  resolvedVehicle: {
    id: '11111111-1111-1111-1111-111111111111',
    make: 'Lamborghini',
    model: 'Urus',
    category: 'SUV',
    luxuryTier: 'ULTRA_LUXURY',
    seats: 5,
    luggage: 4,
    transmission: 'AUTOMATIC',
    availabilityStatus: 'AVAILABLE',
    pricingProfile: { currency: 'AED', dailyRate: 3500 },
    active: true,
  },
  confidence: 0.95,
  ambiguities: [],
  validationErrors: [],
  alternatives: [],
  flags: { promptInjectionDetected: false },
  modelMetadata: { engine: 'vehicle-validation-v1', version: '0.1.0', deterministic: true },
};

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function makeDeps() {
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  };
  const orchestrator = { determine: vi.fn().mockResolvedValue(fakeDetermination) };
  return { prisma, orchestrator } as never;
}

describe('determineVehicle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws NOT_FOUND when the conversation has no message', async () => {
    mocks.findMessagesForConversation.mockResolvedValue([]);
    await expect(
      determineVehicle(makeDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        requestId: 'req-1',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('runs the orchestrator on the latest message content, scoped to the tenant, and persists the result', async () => {
    mocks.findMessagesForConversation.mockResolvedValue([
      { id: 'msg-1', content: 'I want a Lamborghini Urus' },
    ]);
    const deps = makeDeps();

    const result = await determineVehicle(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      requestId: 'req-1',
    });

    expect(
      (deps as { orchestrator: { determine: ReturnType<typeof vi.fn> } }).orchestrator.determine,
    ).toHaveBeenCalledWith('I want a Lamborghini Urus', { tenantId: TENANT_ID });
    expect(mocks.createVehicleDetermination).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ tenantId: TENANT_ID, messageId: 'msg-1' }),
    );
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'vehicle.determined', entityId: 'msg-1' }),
    );
    expect(result.conversationId).toBe('conv-1');
    expect(result.messageId).toBe('msg-1');
    expect(result.determination).toEqual(fakeDetermination);
  });

  it('determines from every message in the conversation, joined oldest first, but persists against the latest message', async () => {
    mocks.findMessagesForConversation.mockResolvedValue([
      { id: 'msg-1', content: 'pickup 15 to 19 Oct, Dubai Marina' },
      { id: 'msg-2', content: 'I want a Lamborghini Urus' },
    ]);
    const deps = makeDeps();

    const result = await determineVehicle(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      requestId: 'req-1',
    });

    expect(
      (deps as { orchestrator: { determine: ReturnType<typeof vi.fn> } }).orchestrator.determine,
    ).toHaveBeenCalledWith('pickup 15 to 19 Oct, Dubai Marina\nI want a Lamborghini Urus', {
      tenantId: TENANT_ID,
    });
    expect(result.messageId).toBe('msg-2');
  });
});
