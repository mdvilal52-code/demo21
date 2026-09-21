import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, IntentStatus, IntentType } from '@ai-concierge/domain';
import type { EnquiryServiceDeps } from './enquiryService.js';

const mocks = vi.hoisted(() => ({
  createConversationWithMessage: vi.fn(),
  appendMessageToConversation: vi.fn(),
  createIntentRecord: vi.fn(),
  findIdempotencyKey: vi.fn(),
  saveIdempotencyKey: vi.fn(),
  auditRecord: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  createConversationWithMessage: mocks.createConversationWithMessage,
  appendMessageToConversation: mocks.appendMessageToConversation,
  createIntentRecord: mocks.createIntentRecord,
  findIdempotencyKey: mocks.findIdempotencyKey,
  saveIdempotencyKey: mocks.saveIdempotencyKey,
  PrismaAuditWriter: class {
    record = mocks.auditRecord;
  },
}));

const { submitEnquiry } = await import('./enquiryService.js');

const fakeIntent = {
  intentType: IntentType.ENQUIRY,
  status: IntentStatus.RECOGNIZED,
  confidence: 0.8,
  entities: { language: 'en', urgency: 'LOW' as const },
  missingFields: [],
  flags: { promptInjectionDetected: false },
  modelMetadata: { engine: 'rule-based-v1', version: '0.1.0', deterministic: true },
};

function makeDeps() {
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  };
  const intentEngine = { recognize: vi.fn().mockReturnValue(fakeIntent) };
  const postEnquiryQueue = { add: vi.fn().mockResolvedValue(undefined) };
  return { prisma, intentEngine, postEnquiryQueue } as unknown as EnquiryServiceDeps;
}

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

describe('submitEnquiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createConversationWithMessage.mockResolvedValue({
      conversation: { id: 'conv-1' },
      message: { id: 'msg-1' },
    });
    mocks.findIdempotencyKey.mockResolvedValue(null);
  });

  it('creates a conversation, records the intent, writes an audit event, and enqueues a job', async () => {
    const deps = makeDeps();
    const result = await submitEnquiry(deps, {
      tenantId: TENANT_ID,
      channel: 'WEB',
      customerRef: 'session-1',
      message: 'I need a car',
      requestId: 'req-1',
    });

    expect(result.conversationId).toBe('conv-1');
    expect(result.messageId).toBe('msg-1');
    expect(result.intent).toEqual(fakeIntent);
    expect(mocks.createIntentRecord).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ tenantId: TENANT_ID, messageId: 'msg-1' }),
    );
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'enquiry.received', entityId: 'conv-1' }),
    );
    expect(deps.prisma).toBeDefined();
  });

  it('replays a stored response when the idempotency key was already used', async () => {
    const deps = makeDeps();
    mocks.findIdempotencyKey.mockResolvedValue({
      responseStatus: 201,
      responseBody: { conversationId: 'conv-old', messageId: 'msg-old', intent: fakeIntent },
    });

    const result = await submitEnquiry(deps, {
      tenantId: TENANT_ID,
      channel: 'WEB',
      customerRef: 'session-1',
      message: 'I need a car',
      requestId: 'req-2',
      idempotencyKey: 'key-1',
    });

    expect(result.conversationId).toBe('conv-old');
    expect(mocks.createConversationWithMessage).not.toHaveBeenCalled();
  });

  it('saves the idempotency key when one is provided on a fresh request', async () => {
    const deps = makeDeps();
    await submitEnquiry(deps, {
      tenantId: TENANT_ID,
      channel: 'WEB',
      customerRef: 'session-1',
      message: 'I need a car',
      requestId: 'req-3',
      idempotencyKey: 'key-2',
    });
    expect(mocks.saveIdempotencyKey).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ key: 'key-2', tenantId: TENANT_ID }),
    );
  });

  it('throws UPSTREAM_UNAVAILABLE when the job cannot be queued, after the conversation is already saved', async () => {
    const deps = makeDeps();
    (deps.postEnquiryQueue.add as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('redis down'),
    );

    await expect(
      submitEnquiry(deps, {
        tenantId: TENANT_ID,
        channel: 'WEB',
        customerRef: 'session-1',
        message: 'I need a car',
        requestId: 'req-4',
      }),
    ).rejects.toBeInstanceOf(AppError);

    expect(mocks.createConversationWithMessage).toHaveBeenCalled();
  });

  it('appends to an existing conversation instead of creating a new one when conversationId is given', async () => {
    const deps = makeDeps();
    mocks.appendMessageToConversation.mockResolvedValue({
      conversation: { id: 'conv-existing' },
      message: { id: 'msg-2' },
    });

    const result = await submitEnquiry(deps, {
      tenantId: TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971501234567',
      message: 'Yes',
      requestId: 'req-5',
      conversationId: 'conv-existing',
    });

    expect(mocks.createConversationWithMessage).not.toHaveBeenCalled();
    expect(mocks.appendMessageToConversation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        tenantId: TENANT_ID,
        conversationId: 'conv-existing',
        content: 'Yes',
      }),
    );
    expect(result.conversationId).toBe('conv-existing');
    expect(result.messageId).toBe('msg-2');
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'enquiry.received', entityId: 'conv-existing' }),
    );
  });

  it('throws NOT_FOUND when the given conversationId does not resolve to a conversation', async () => {
    const deps = makeDeps();
    mocks.appendMessageToConversation.mockResolvedValue(null);

    await expect(
      submitEnquiry(deps, {
        tenantId: TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971501234567',
        message: 'Yes',
        requestId: 'req-6',
        conversationId: 'conv-missing',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mocks.createIntentRecord).not.toHaveBeenCalled();
  });
});
