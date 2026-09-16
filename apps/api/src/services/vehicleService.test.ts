import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@ai-concierge/domain';

const mocks = vi.hoisted(() => ({
  findLatestMessageForConversation: vi.fn(),
  createVehicleDetermination: vi.fn(),
  auditRecord: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  findLatestMessageForConversation: mocks.findLatestMessageForConversation,
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
    mocks.findLatestMessageForConversation.mockResolvedValue(null);
    await expect(
      determineVehicle(makeDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        requestId: 'req-1',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('runs the orchestrator on the latest message content, scoped to the tenant, and persists the result', async () => {
    mocks.findLatestMessageForConversation.mockResolvedValue({
      id: 'msg-1',
      content: 'I want a Lamborghini Urus',
    });
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
});
