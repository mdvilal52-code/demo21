import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@ai-concierge/domain';

const mocks = vi.hoisted(() => ({
  findMessagesForConversation: vi.fn(),
  createDateLocationExtraction: vi.fn(),
  auditRecord: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  findMessagesForConversation: mocks.findMessagesForConversation,
  createDateLocationExtraction: mocks.createDateLocationExtraction,
  PrismaAuditWriter: class {
    record = mocks.auditRecord;
  },
}));

const { extractDatesAndLocation } = await import('./dateLocationService.js');

const fakeExtraction = {
  pickupDate: '2026-10-15T06:00:00.000Z',
  returnDate: null,
  timezone: 'Asia/Dubai',
  pickupLocation: null,
  dropoffLocation: null,
  locationType: null,
  confidence: 0.6,
  ambiguities: [],
  validationErrors: [],
  flags: { promptInjectionDetected: false },
  modelMetadata: { engine: 'temporal-validation-v1', version: '0.1.0', deterministic: true },
};

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function makeDeps() {
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  };
  const orchestrator = { extract: vi.fn().mockResolvedValue(fakeExtraction) };
  return { prisma, orchestrator } as never;
}

describe('extractDatesAndLocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws NOT_FOUND when the conversation has no message', async () => {
    mocks.findMessagesForConversation.mockResolvedValue([]);
    await expect(
      extractDatesAndLocation(makeDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        requestId: 'req-1',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('runs the orchestrator on the latest message content and persists the result', async () => {
    mocks.findMessagesForConversation.mockResolvedValue([
      { id: 'msg-1', content: 'pickup 15 Oct' },
    ]);
    const deps = makeDeps();

    const result = await extractDatesAndLocation(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      requestId: 'req-1',
    });

    expect(
      (deps as { orchestrator: { extract: ReturnType<typeof vi.fn> } }).orchestrator.extract,
    ).toHaveBeenCalledWith('pickup 15 Oct');
    expect(mocks.createDateLocationExtraction).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ tenantId: TENANT_ID, messageId: 'msg-1' }),
    );
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'dates_location.extracted', entityId: 'msg-1' }),
    );
    expect(result.conversationId).toBe('conv-1');
    expect(result.messageId).toBe('msg-1');
    expect(result.extraction).toEqual(fakeExtraction);
  });

  it('extracts from every message in the conversation, joined oldest first, but persists against the latest message', async () => {
    mocks.findMessagesForConversation.mockResolvedValue([
      { id: 'msg-1', content: 'I want a Lamborghini Urus' },
      { id: 'msg-2', content: '15 to 19 Oct' },
    ]);
    const deps = makeDeps();

    const result = await extractDatesAndLocation(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      requestId: 'req-1',
    });

    expect(
      (deps as { orchestrator: { extract: ReturnType<typeof vi.fn> } }).orchestrator.extract,
    ).toHaveBeenCalledWith('I want a Lamborghini Urus\n15 to 19 Oct');
    expect(mocks.createDateLocationExtraction).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ tenantId: TENANT_ID, messageId: 'msg-2' }),
    );
    expect(result.messageId).toBe('msg-2');
  });
});
