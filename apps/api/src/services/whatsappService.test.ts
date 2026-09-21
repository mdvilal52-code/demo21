import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findIdempotencyKey: vi.fn(),
  findLatestConversationForCustomer: vi.fn(),
  updateConversationStage: vi.fn(),
  auditRecord: vi.fn(),
  submitEnquiry: vi.fn(),
  advanceWhatsAppConversation: vi.fn(),
  sendTextMessage: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  findIdempotencyKey: mocks.findIdempotencyKey,
  findLatestConversationForCustomer: mocks.findLatestConversationForCustomer,
  updateConversationStage: mocks.updateConversationStage,
  PrismaAuditWriter: class {
    record = mocks.auditRecord;
  },
}));
vi.mock('./enquiryService.js', () => ({ submitEnquiry: mocks.submitEnquiry }));
vi.mock('./whatsappConversationState.js', () => ({
  advanceWhatsAppConversation: mocks.advanceWhatsAppConversation,
}));

const { handleInboundWhatsAppMessage } = await import('./whatsappService.js');

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const NEXT_CYCLE_STARTED_AT = new Date('2026-09-20T10:00:00.000Z');

const fakeIntent = {
  intentType: 'UNKNOWN',
  status: 'RECOGNIZED',
  confidence: 0.9,
  entities: { language: 'en', urgency: 'LOW' as const },
  missingFields: [],
  flags: { promptInjectionDetected: false },
  modelMetadata: { engine: 'rule-based-v1', version: '0.1.0', deterministic: true },
};

function makeDeps() {
  return {
    prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})) },
    intentEngine: {},
    postEnquiryQueue: {},
    dateLocationOrchestrator: {},
    vehicleOrchestrator: {},
    missingInfoOrchestrator: {},
    whatsappClient: { sendTextMessage: mocks.sendTextMessage },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

describe('handleInboundWhatsAppMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks() only clears call history, not a previously-set
    // implementation — an explicit default here prevents one test's
    // mockRejectedValue/mockImplementation from leaking into the next.
    mocks.sendTextMessage.mockResolvedValue(undefined);
    mocks.findLatestConversationForCustomer.mockResolvedValue(null);
    mocks.updateConversationStage.mockResolvedValue({ count: 1 });
    mocks.submitEnquiry.mockResolvedValue({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      intent: fakeIntent,
    });
    mocks.advanceWhatsAppConversation.mockResolvedValue({
      replyText: 'Thanks for reaching out! 😊 ...',
      nextStage: 'AWAITING_BOOKING_CONFIRMATION',
      nextCycleStartedAt: NEXT_CYCLE_STARTED_AT,
    });
  });

  it('skips processing entirely for a duplicate message id', async () => {
    mocks.findIdempotencyKey.mockResolvedValue({ responseStatus: 201, responseBody: {} });

    await handleInboundWhatsAppMessage(makeDeps(), {
      tenantId: TENANT_ID,
      requestId: 'req-1',
      message: { from: '971501234567', id: 'wamid.DUP', type: 'text', text: 'hello again' },
    });

    expect(mocks.submitEnquiry).not.toHaveBeenCalled();
    expect(mocks.sendTextMessage).not.toHaveBeenCalled();
  });

  it('replies with the unsupported-type message and skips the pipeline for non-text messages', async () => {
    mocks.findIdempotencyKey.mockResolvedValue(null);

    await handleInboundWhatsAppMessage(makeDeps(), {
      tenantId: TENANT_ID,
      requestId: 'req-1',
      message: { from: '971501234567', id: 'wamid.IMG', type: 'image', text: null },
    });

    expect(mocks.submitEnquiry).not.toHaveBeenCalled();
    expect(mocks.sendTextMessage).toHaveBeenCalledWith(
      '971501234567',
      expect.stringMatching(/only read text messages/),
    );
  });

  it('replies with the too-long message and skips the pipeline for an empty/oversized body', async () => {
    mocks.findIdempotencyKey.mockResolvedValue(null);

    await handleInboundWhatsAppMessage(makeDeps(), {
      tenantId: TENANT_ID,
      requestId: 'req-1',
      message: { from: '971501234567', id: 'wamid.LONG', type: 'text', text: '' },
    });

    expect(mocks.submitEnquiry).not.toHaveBeenCalled();
    expect(mocks.sendTextMessage).toHaveBeenCalledWith(
      '971501234567',
      expect.stringMatching(/too long/),
    );
  });

  it('starts a brand-new conversation (no conversationId) for a first-time customer, stage NEW', async () => {
    mocks.findIdempotencyKey.mockResolvedValue(null);
    mocks.findLatestConversationForCustomer.mockResolvedValue(null);

    await handleInboundWhatsAppMessage(makeDeps(), {
      tenantId: TENANT_ID,
      requestId: 'req-1',
      message: { from: '971501234567', id: 'wamid.NEW', type: 'text', text: 'Hiii' },
    });

    expect(mocks.findLatestConversationForCustomer).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      'WHATSAPP',
      '971501234567',
    );
    expect(mocks.submitEnquiry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971501234567',
        message: 'Hiii',
        idempotencyKey: 'wamid.NEW',
        conversationId: undefined,
      }),
    );
    expect(mocks.advanceWhatsAppConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: 'conv-1',
        stage: 'NEW',
        intent: fakeIntent,
        messageText: 'Hiii',
      }),
    );
    expect(mocks.updateConversationStage).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      'conv-1',
      'AWAITING_BOOKING_CONFIRMATION',
      NEXT_CYCLE_STARTED_AT,
    );
    expect(mocks.sendTextMessage).toHaveBeenCalledWith(
      '971501234567',
      'Thanks for reaching out! 😊 ...',
    );
    // The stage transition is an audited mutation, same as every other write
    // in this pipeline.
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'conversation.stage_advanced',
        entityId: 'conv-1',
        after: { stage: 'AWAITING_BOOKING_CONFIRMATION' },
      }),
    );
  });

  it('sends the reply before persisting the new stage', async () => {
    mocks.findIdempotencyKey.mockResolvedValue(null);
    const order: string[] = [];
    mocks.sendTextMessage.mockImplementation(async () => {
      order.push('send');
    });
    mocks.updateConversationStage.mockImplementation(async () => {
      order.push('persist');
      return { count: 1 };
    });

    await handleInboundWhatsAppMessage(makeDeps(), {
      tenantId: TENANT_ID,
      requestId: 'req-1',
      message: { from: '971501234567', id: 'wamid.ORDER', type: 'text', text: 'Hiii' },
    });

    expect(order).toEqual(['send', 'persist']);
  });

  it('does not persist the new stage (or write an audit event) when the send itself fails', async () => {
    mocks.findIdempotencyKey.mockResolvedValue(null);
    // Once, not always: the fallback reply in the outer catch also calls
    // sendTextMessage, and it should succeed so the test isn't asserting
    // behavior it can't actually observe.
    mocks.sendTextMessage.mockRejectedValueOnce(new Error('WhatsApp API rate limited'));

    await handleInboundWhatsAppMessage(makeDeps(), {
      tenantId: TENANT_ID,
      requestId: 'req-1',
      message: { from: '971501234567', id: 'wamid.SENDFAIL', type: 'text', text: 'Hiii' },
    });

    expect(mocks.updateConversationStage).not.toHaveBeenCalled();
    expect(mocks.auditRecord).not.toHaveBeenCalled();
    // The outer catch's generic fallback is the *second* send attempt.
    expect(mocks.sendTextMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendTextMessage).toHaveBeenLastCalledWith(
      '971501234567',
      expect.stringMatching(/something went wrong/),
    );
  });

  it("resumes an existing customer's conversation from its saved stage instead of starting fresh", async () => {
    mocks.findIdempotencyKey.mockResolvedValue(null);
    mocks.findLatestConversationForCustomer.mockResolvedValue({
      id: 'conv-existing',
      stage: 'AWAITING_BOOKING_CONFIRMATION',
      cycleStartedAt: new Date('2026-09-19T00:00:00.000Z'),
    });
    mocks.submitEnquiry.mockResolvedValue({
      conversationId: 'conv-existing',
      messageId: 'msg-2',
      intent: fakeIntent,
    });
    mocks.advanceWhatsAppConversation.mockResolvedValue({
      replyText: 'Great! 😊 Which car would you like to book?',
      nextStage: 'COLLECTING_VEHICLE',
      nextCycleStartedAt: new Date('2026-09-19T00:00:00.000Z'),
    });

    await handleInboundWhatsAppMessage(makeDeps(), {
      tenantId: TENANT_ID,
      requestId: 'req-2',
      message: { from: '971501234567', id: 'wamid.YES', type: 'text', text: 'Yes' },
    });

    expect(mocks.submitEnquiry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'conv-existing', message: 'Yes' }),
    );
    expect(mocks.advanceWhatsAppConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: 'conv-existing',
        stage: 'AWAITING_BOOKING_CONFIRMATION',
        cycleStartedAt: new Date('2026-09-19T00:00:00.000Z'),
        messageText: 'Yes',
      }),
    );
    expect(mocks.updateConversationStage).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      'conv-existing',
      'COLLECTING_VEHICLE',
      new Date('2026-09-19T00:00:00.000Z'),
    );
    expect(mocks.sendTextMessage).toHaveBeenCalledWith(
      '971501234567',
      'Great! 😊 Which car would you like to book?',
    );
    // The reply is the Stage 2 question, never the original Stage 1 greeting repeated.
    expect(mocks.sendTextMessage).not.toHaveBeenCalledWith(
      '971501234567',
      expect.stringMatching(/reaching out/),
    );
  });

  it('sends a fallback reply and does not throw when the pipeline fails', async () => {
    mocks.findIdempotencyKey.mockResolvedValue(null);
    mocks.submitEnquiry.mockRejectedValue(new Error('db down'));

    await expect(
      handleInboundWhatsAppMessage(makeDeps(), {
        tenantId: TENANT_ID,
        requestId: 'req-1',
        message: { from: '971501234567', id: 'wamid.ERR', type: 'text', text: 'I want a car' },
      }),
    ).resolves.toBeUndefined();

    expect(mocks.sendTextMessage).toHaveBeenCalledWith(
      '971501234567',
      expect.stringMatching(/something went wrong/),
    );
  });
});
