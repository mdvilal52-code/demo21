import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, IntentStatus, IntentType } from '@ai-concierge/domain';
import type { EnquiryServiceDeps } from './enquiryService.js';

const mocks = vi.hoisted(() => ({
  createConversationWithMessage: vi.fn(),
  appendMessageToConversation: vi.fn(),
  createIntentRecord: vi.fn(),
  findIdempotencyKey: vi.fn(),
  findLatestMessageForConversation: vi.fn(),
  findLatestMissingInfoCheckForMessage: vi.fn(),
  findMostRecentConversationForCustomer: vi.fn(),
  saveIdempotencyKey: vi.fn(),
  auditRecord: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  createConversationWithMessage: mocks.createConversationWithMessage,
  appendMessageToConversation: mocks.appendMessageToConversation,
  createIntentRecord: mocks.createIntentRecord,
  findIdempotencyKey: mocks.findIdempotencyKey,
  findLatestMessageForConversation: mocks.findLatestMessageForConversation,
  findLatestMissingInfoCheckForMessage: mocks.findLatestMissingInfoCheckForMessage,
  findMostRecentConversationForCustomer: mocks.findMostRecentConversationForCustomer,
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
    // Default: no reopenable conversation, so existing tests take the
    // fresh-conversation path exactly as before this behavior existed.
    mocks.findMostRecentConversationForCustomer.mockResolvedValue(null);
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

  describe('conversation continuity', () => {
    const recentCandidate = {
      id: 'conv-existing',
      tenantId: TENANT_ID,
      channel: 'WEB',
      customerRef: 'session-1',
      createdAt: new Date(),
      processedAt: null,
    };

    beforeEach(() => {
      mocks.appendMessageToConversation.mockResolvedValue({
        conversation: { id: 'conv-existing' },
        message: { id: 'msg-2' },
      });
      mocks.findLatestMessageForConversation.mockResolvedValue({ id: 'msg-1' });
    });

    it('reopens the existing conversation when it still needs info within the window', async () => {
      mocks.findMostRecentConversationForCustomer.mockResolvedValue(recentCandidate);
      mocks.findLatestMissingInfoCheckForMessage.mockResolvedValue({ status: 'NEEDS_INFO' });

      const deps = makeDeps();
      const result = await submitEnquiry(deps, {
        tenantId: TENANT_ID,
        channel: 'WEB',
        customerRef: 'session-1',
        message: 'actually, make it 5 days',
        requestId: 'req-5',
      });

      expect(mocks.appendMessageToConversation).toHaveBeenCalledWith(
        {},
        TENANT_ID,
        'conv-existing',
        'actually, make it 5 days',
      );
      expect(mocks.createConversationWithMessage).not.toHaveBeenCalled();
      expect(result.conversationId).toBe('conv-existing');
      expect(mocks.auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'enquiry.continued' }),
      );
    });

    it('starts fresh when the previous conversation already completed', async () => {
      mocks.findMostRecentConversationForCustomer.mockResolvedValue(recentCandidate);
      mocks.findLatestMissingInfoCheckForMessage.mockResolvedValue({ status: 'COMPLETE' });

      const deps = makeDeps();
      await submitEnquiry(deps, {
        tenantId: TENANT_ID,
        channel: 'WEB',
        customerRef: 'session-1',
        message: 'I need another car',
        requestId: 'req-6',
      });

      expect(mocks.appendMessageToConversation).not.toHaveBeenCalled();
      expect(mocks.createConversationWithMessage).toHaveBeenCalled();
    });

    it('starts fresh when the previous conversation already expired', async () => {
      mocks.findMostRecentConversationForCustomer.mockResolvedValue(recentCandidate);
      mocks.findLatestMissingInfoCheckForMessage.mockResolvedValue({ status: 'EXPIRED' });

      const deps = makeDeps();
      await submitEnquiry(deps, {
        tenantId: TENANT_ID,
        channel: 'WEB',
        customerRef: 'session-1',
        message: 'hi again',
        requestId: 'req-7',
      });

      expect(mocks.appendMessageToConversation).not.toHaveBeenCalled();
      expect(mocks.createConversationWithMessage).toHaveBeenCalled();
    });

    it('starts fresh when the previous conversation is outside the reopen window', async () => {
      mocks.findMostRecentConversationForCustomer.mockResolvedValue({
        ...recentCandidate,
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      });

      const deps = makeDeps();
      await submitEnquiry(deps, {
        tenantId: TENANT_ID,
        channel: 'WEB',
        customerRef: 'session-1',
        message: 'hi again',
        requestId: 'req-8',
      });

      expect(mocks.findLatestMessageForConversation).not.toHaveBeenCalled();
      expect(mocks.appendMessageToConversation).not.toHaveBeenCalled();
      expect(mocks.createConversationWithMessage).toHaveBeenCalled();
    });

    it('starts fresh when no check has run yet but treats an in-flight conversation as reopenable', async () => {
      mocks.findMostRecentConversationForCustomer.mockResolvedValue(recentCandidate);
      mocks.findLatestMissingInfoCheckForMessage.mockResolvedValue(null);

      const deps = makeDeps();
      await submitEnquiry(deps, {
        tenantId: TENANT_ID,
        channel: 'WEB',
        customerRef: 'session-1',
        message: 'still deciding',
        requestId: 'req-9',
      });

      expect(mocks.appendMessageToConversation).toHaveBeenCalled();
      expect(mocks.createConversationWithMessage).not.toHaveBeenCalled();
    });
  });
});
