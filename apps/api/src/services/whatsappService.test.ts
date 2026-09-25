import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findIdempotencyKey: vi.fn(),
  findMessagesForConversation: vi.fn(),
  submitEnquiry: vi.fn(),
  extractDatesAndLocation: vi.fn(),
  determineVehicle: vi.fn(),
  checkMissingInfo: vi.fn(),
  generateConversationalReply: vi.fn(),
  sendTextMessage: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  findIdempotencyKey: mocks.findIdempotencyKey,
  findMessagesForConversation: mocks.findMessagesForConversation,
}));
vi.mock('./enquiryService.js', () => ({ submitEnquiry: mocks.submitEnquiry }));
vi.mock('./dateLocationService.js', () => ({
  extractDatesAndLocation: mocks.extractDatesAndLocation,
}));
vi.mock('./vehicleService.js', () => ({ determineVehicle: mocks.determineVehicle }));
vi.mock('./missingInfoService.js', () => ({ checkMissingInfo: mocks.checkMissingInfo }));
vi.mock('./conversationalReplyService.js', () => ({
  generateConversationalReply: mocks.generateConversationalReply,
  MAX_RECENT_TURNS_FOR_REPLY: 12,
}));

const { handleInboundWhatsAppMessage } = await import('./whatsappService.js');

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function makeDeps() {
  return {
    prisma: {},
    intentEngine: {},
    postEnquiryQueue: {},
    dateLocationOrchestrator: {},
    vehicleOrchestrator: {},
    missingInfoOrchestrator: {},
    whatsappClient: { sendTextMessage: mocks.sendTextMessage },
    aiProvider: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

const fakeMissingInfo = {
  status: 'NEEDS_INFO',
  collected: {
    pickupDate: null,
    returnDate: null,
    pickupLocation: null,
    dropoffLocation: null,
    vehicle: null,
  },
  missingFields: [],
  clarificationPrompt: 'When would you like to pick up the car?',
  expiresAt: '2026-09-21T00:00:00.000Z',
  flags: { promptInjectionDetectedAnywhere: false },
  modelMetadata: { engine: 'missing-info-evaluator-v1', version: '0.1.0', deterministic: true },
};

describe('handleInboundWhatsAppMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.submitEnquiry.mockResolvedValue({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      intent: {},
    });
    mocks.extractDatesAndLocation.mockResolvedValue({});
    mocks.determineVehicle.mockResolvedValue({});
    mocks.checkMissingInfo.mockResolvedValue({ missingInfo: fakeMissingInfo });
    mocks.findMessagesForConversation.mockResolvedValue([]);
    mocks.generateConversationalReply.mockResolvedValue({
      text: fakeMissingInfo.clarificationPrompt,
      source: 'DETERMINISTIC_FALLBACK',
      fallbackReason: 'NOT_CONFIGURED',
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

  it('runs the full Steps 1-4 pipeline and sends the generated reply for a valid text message', async () => {
    mocks.findIdempotencyKey.mockResolvedValue(null);
    mocks.findMessagesForConversation.mockResolvedValue([
      { id: 'msg-0', conversationId: 'conv-1', content: 'I want a Urus', createdAt: new Date() },
      { id: 'msg-1', conversationId: 'conv-1', content: 'I want a car', createdAt: new Date() },
    ]);

    await handleInboundWhatsAppMessage(makeDeps(), {
      tenantId: TENANT_ID,
      requestId: 'req-1',
      message: { from: '971501234567', id: 'wamid.OK', type: 'text', text: 'I want a car' },
    });

    expect(mocks.submitEnquiry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: TENANT_ID,
        channel: 'WHATSAPP',
        customerRef: '971501234567',
        message: 'I want a car',
        idempotencyKey: 'wamid.OK',
      }),
    );
    expect(mocks.extractDatesAndLocation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
    expect(mocks.determineVehicle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
    expect(mocks.checkMissingInfo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
    expect(mocks.generateConversationalReply).toHaveBeenCalledWith(
      expect.objectContaining({ aiProvider: expect.anything() }),
      {
        missingInfo: fakeMissingInfo,
        recentTurns: [
          { role: 'customer', content: 'I want a Urus' },
          { role: 'customer', content: 'I want a car' },
        ],
      },
    );
    expect(mocks.sendTextMessage).toHaveBeenCalledWith(
      '971501234567',
      'When would you like to pick up the car?',
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
