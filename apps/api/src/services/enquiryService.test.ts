import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, IntentStatus, IntentType } from '@ai-concierge/domain';
import type { ContinueEnquiryDeps, EnquiryServiceDeps } from './enquiryService.js';

const mocks = vi.hoisted(() => ({
  createConversationWithMessage: vi.fn(),
  createIntentRecord: vi.fn(),
  findIdempotencyKey: vi.fn(),
  saveIdempotencyKey: vi.fn(),
  auditRecord: vi.fn(),
  appendMessageToConversation: vi.fn(),
  findMessagesForConversation: vi.fn(),
  hasBookingRequestIntentInConversation: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  createConversationWithMessage: mocks.createConversationWithMessage,
  createIntentRecord: mocks.createIntentRecord,
  findIdempotencyKey: mocks.findIdempotencyKey,
  saveIdempotencyKey: mocks.saveIdempotencyKey,
  appendMessageToConversation: mocks.appendMessageToConversation,
  findMessagesForConversation: mocks.findMessagesForConversation,
  hasBookingRequestIntentInConversation: mocks.hasBookingRequestIntentInConversation,
  PrismaAuditWriter: class {
    record = mocks.auditRecord;
  },
}));

const { submitEnquiry, continueEnquiry } = await import('./enquiryService.js');

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

  it('corrects a first message that is already booking-shaped (e.g. a bare vehicle name) to BOOKING_REQUEST', async () => {
    const deps = makeDeps();
    const vehicleOnlyIntent = {
      ...fakeIntent,
      intentType: IntentType.UNKNOWN,
      entities: { ...fakeIntent.entities, vehicleIntent: 'lamborghini' },
    };
    (deps.intentEngine.recognize as ReturnType<typeof vi.fn>).mockReturnValue(vehicleOnlyIntent);

    const result = await submitEnquiry(deps, {
      tenantId: TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000000',
      message: 'Lamborghini Urus',
      requestId: 'req-first-vehicle',
    });

    expect(result.intent.intentType).toBe(IntentType.BOOKING_REQUEST);
    expect(result.intent.missingFields).toEqual(['pickupDate', 'returnDate', 'location']);
  });

  it('leaves a first message with no booking-shaped entities as UNKNOWN (no prior conversation to be sticky about)', async () => {
    const deps = makeDeps();
    const unknownIntent = { ...fakeIntent, intentType: IntentType.UNKNOWN };
    (deps.intentEngine.recognize as ReturnType<typeof vi.fn>).mockReturnValue(unknownIntent);

    const result = await submitEnquiry(deps, {
      tenantId: TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971500000000',
      message: 'Hi',
      requestId: 'req-first-hi',
    });

    expect(result.intent.intentType).toBe(IntentType.UNKNOWN);
  });
});

function makeContinueDeps() {
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  };
  const intentEngine = { recognize: vi.fn().mockReturnValue(fakeIntent) };
  return { prisma, intentEngine } as unknown as ContinueEnquiryDeps;
}

describe('continueEnquiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIdempotencyKey.mockResolvedValue(null);
    mocks.findMessagesForConversation.mockResolvedValue([
      { id: 'msg-1', conversationId: 'conv-1', content: 'I want a Lamborghini Urus' },
    ]);
    mocks.appendMessageToConversation.mockResolvedValue({
      id: 'msg-2',
      conversationId: 'conv-1',
      content: '15 to 19 Oct',
    });
    mocks.hasBookingRequestIntentInConversation.mockResolvedValue(false);
  });

  it('appends the message, recognizes intent from the accumulated transcript, and records the intent against the new message', async () => {
    const deps = makeContinueDeps();
    const result = await continueEnquiry(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      channel: 'WHATSAPP',
      message: '15 to 19 Oct',
      requestId: 'req-1',
    });

    expect(mocks.appendMessageToConversation).toHaveBeenCalledWith(
      {},
      TENANT_ID,
      'conv-1',
      '15 to 19 Oct',
    );
    expect(deps.intentEngine.recognize).toHaveBeenCalledWith(
      'I want a Lamborghini Urus\n15 to 19 Oct',
    );
    expect(mocks.createIntentRecord).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ tenantId: TENANT_ID, messageId: 'msg-2' }),
    );
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'enquiry.continued', entityId: 'conv-1' }),
    );
    expect(result).toEqual({ conversationId: 'conv-1', messageId: 'msg-2', intent: fakeIntent });
  });

  it('corrects a bare "Yes" to BOOKING_REQUEST when nothing booking-shaped has been recognized yet', async () => {
    const unrecognizedIntent = {
      ...fakeIntent,
      intentType: IntentType.UNKNOWN,
      status: IntentStatus.RECOGNIZED,
    };
    mocks.findMessagesForConversation.mockResolvedValue([
      { id: 'msg-1', conversationId: 'conv-1', content: 'Hiii' },
    ]);
    mocks.appendMessageToConversation.mockResolvedValue({
      id: 'msg-2',
      conversationId: 'conv-1',
      content: 'Yes',
    });
    const deps = makeContinueDeps();
    (deps.intentEngine.recognize as ReturnType<typeof vi.fn>).mockReturnValue(unrecognizedIntent);

    const result = await continueEnquiry(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      channel: 'WHATSAPP',
      message: 'Yes',
      requestId: 'req-yes',
    });

    expect(result.intent.intentType).toBe(IntentType.BOOKING_REQUEST);
    // No vehicle/dates/location were ever mentioned, so this stays
    // NEEDS_CLARIFICATION with all four fields listed — internally
    // consistent with the corrected intentType, not the stale UNKNOWN
    // classification's (always-empty) missingFields.
    expect(result.intent.status).toBe(IntentStatus.NEEDS_CLARIFICATION);
    expect(result.intent.missingFields).toEqual([
      'vehicleIntent',
      'pickupDate',
      'returnDate',
      'location',
    ]);
    expect(result.intent.clarificationPrompt).toContain('vehicleIntent');
    // The correction is auditable/distinguishable from a real keyword match.
    expect(result.intent.modelMetadata.engine).toBe('short-reply-confirmation-v1');
    expect(mocks.createIntentRecord).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        intentResult: expect.objectContaining({ intentType: IntentType.BOOKING_REQUEST }),
      }),
    );
  });

  it('does not overwrite a different, already-recognized intent (e.g. a complaint) just because the reply is affirmative', async () => {
    const complaintIntent = { ...fakeIntent, intentType: IntentType.COMPLAINT };
    mocks.findMessagesForConversation.mockResolvedValue([
      { id: 'msg-1', conversationId: 'conv-1', content: 'I have a complaint about my rental' },
    ]);
    mocks.appendMessageToConversation.mockResolvedValue({
      id: 'msg-2',
      conversationId: 'conv-1',
      content: 'Yes',
    });
    const deps = makeContinueDeps();
    (deps.intentEngine.recognize as ReturnType<typeof vi.fn>).mockReturnValue(complaintIntent);

    const result = await continueEnquiry(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      channel: 'WHATSAPP',
      message: 'Yes',
      requestId: 'req-complaint-yes',
    });

    // A "Yes" answering a complaint-related question is not a booking
    // confirmation — only an UNKNOWN classification is ambiguous enough to
    // correct.
    expect(result.intent).toEqual(complaintIntent);
  });

  it('does not correct a bare "Yes" when the transcript already recognized a booking request', async () => {
    const alreadyBooking = { ...fakeIntent, intentType: IntentType.BOOKING_REQUEST };
    mocks.findMessagesForConversation.mockResolvedValue([
      { id: 'msg-1', conversationId: 'conv-1', content: 'I want to rent a car' },
    ]);
    mocks.appendMessageToConversation.mockResolvedValue({
      id: 'msg-2',
      conversationId: 'conv-1',
      content: 'Yes',
    });
    const deps = makeContinueDeps();
    (deps.intentEngine.recognize as ReturnType<typeof vi.fn>).mockReturnValue(alreadyBooking);

    const result = await continueEnquiry(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      channel: 'WHATSAPP',
      message: 'Yes',
      requestId: 'req-yes-2',
    });

    // Unchanged: the engine's own metadata is preserved, nothing overridden.
    expect(result.intent).toEqual(alreadyBooking);
  });

  it('does not correct a message that is not a short affirmative reply', async () => {
    const unrecognizedIntent = { ...fakeIntent, intentType: IntentType.UNKNOWN };
    mocks.findMessagesForConversation.mockResolvedValue([
      { id: 'msg-1', conversationId: 'conv-1', content: 'Hiii' },
    ]);
    mocks.appendMessageToConversation.mockResolvedValue({
      id: 'msg-2',
      conversationId: 'conv-1',
      content: 'What cars do you have?',
    });
    const deps = makeContinueDeps();
    (deps.intentEngine.recognize as ReturnType<typeof vi.fn>).mockReturnValue(unrecognizedIntent);

    const result = await continueEnquiry(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      channel: 'WHATSAPP',
      message: 'What cars do you have?',
      requestId: 'req-other',
    });

    expect(result.intent.intentType).toBe(IntentType.UNKNOWN);
  });

  it('corrects a bare vehicle-name reply to BOOKING_REQUEST via entities, even with no booking keyword', async () => {
    const vehicleOnlyIntent = {
      ...fakeIntent,
      intentType: IntentType.UNKNOWN,
      entities: { ...fakeIntent.entities, vehicleIntent: 'lamborghini' },
    };
    mocks.findMessagesForConversation.mockResolvedValue([
      { id: 'msg-1', conversationId: 'conv-1', content: 'Hi' },
      { id: 'msg-2', conversationId: 'conv-1', content: 'Yes' },
    ]);
    mocks.appendMessageToConversation.mockResolvedValue({
      id: 'msg-3',
      conversationId: 'conv-1',
      content: 'Lamborghini Urus',
    });
    const deps = makeContinueDeps();
    (deps.intentEngine.recognize as ReturnType<typeof vi.fn>).mockReturnValue(vehicleOnlyIntent);

    const result = await continueEnquiry(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      channel: 'WHATSAPP',
      message: 'Lamborghini Urus',
      requestId: 'req-vehicle-only',
    });

    expect(result.intent.intentType).toBe(IntentType.BOOKING_REQUEST);
    expect(result.intent.missingFields).toEqual(['pickupDate', 'returnDate', 'location']);
    // The cheap in-memory entities check is decisive; the durable sticky
    // fallback query is never reached.
    expect(mocks.hasBookingRequestIntentInConversation).not.toHaveBeenCalled();
  });

  it('corrects a dates-only reply to BOOKING_REQUEST via entities', async () => {
    const datesOnlyIntent = {
      ...fakeIntent,
      intentType: IntentType.UNKNOWN,
      entities: {
        ...fakeIntent.entities,
        pickupDate: '2026-09-25T00:00:00.000Z',
        returnDate: '2026-09-28T00:00:00.000Z',
      },
    };
    const deps = makeContinueDeps();
    (deps.intentEngine.recognize as ReturnType<typeof vi.fn>).mockReturnValue(datesOnlyIntent);

    const result = await continueEnquiry(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      channel: 'WHATSAPP',
      message: '25 September to 28 September',
      requestId: 'req-dates-only',
    });

    expect(result.intent.intentType).toBe(IntentType.BOOKING_REQUEST);
    expect(result.intent.missingFields).toEqual(['vehicleIntent', 'location']);
  });

  it('falls back to the durable sticky check when this turn has no entities and is unclear, and corrects when the conversation already had a booking request', async () => {
    const unclearIntent = { ...fakeIntent, intentType: IntentType.UNKNOWN };
    mocks.hasBookingRequestIntentInConversation.mockResolvedValue(true);
    const deps = makeContinueDeps();
    (deps.intentEngine.recognize as ReturnType<typeof vi.fn>).mockReturnValue(unclearIntent);

    const result = await continueEnquiry(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      channel: 'WHATSAPP',
      message: 'hmm not sure what you mean',
      requestId: 'req-unclear-sticky',
    });

    expect(mocks.hasBookingRequestIntentInConversation).toHaveBeenCalledWith(
      {},
      TENANT_ID,
      'conv-1',
    );
    expect(result.intent.intentType).toBe(IntentType.BOOKING_REQUEST);
  });

  it('leaves an unclear reply as UNKNOWN when the sticky check also finds no prior booking request', async () => {
    const unclearIntent = { ...fakeIntent, intentType: IntentType.UNKNOWN };
    mocks.hasBookingRequestIntentInConversation.mockResolvedValue(false);
    const deps = makeContinueDeps();
    (deps.intentEngine.recognize as ReturnType<typeof vi.fn>).mockReturnValue(unclearIntent);

    const result = await continueEnquiry(deps, {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      channel: 'WHATSAPP',
      message: 'hmm not sure what you mean',
      requestId: 'req-unclear-no-sticky',
    });

    expect(result.intent.intentType).toBe(IntentType.UNKNOWN);
  });

  it('throws NOT_FOUND when the conversation does not belong to this tenant', async () => {
    mocks.appendMessageToConversation.mockResolvedValue(null);

    await expect(
      continueEnquiry(makeContinueDeps(), {
        tenantId: TENANT_ID,
        conversationId: 'conv-missing',
        channel: 'WHATSAPP',
        message: 'hello',
        requestId: 'req-2',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('replays a stored response when the idempotency key was already used', async () => {
    mocks.findIdempotencyKey.mockResolvedValue({
      responseStatus: 201,
      responseBody: { conversationId: 'conv-1', messageId: 'msg-old', intent: fakeIntent },
    });

    const result = await continueEnquiry(makeContinueDeps(), {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      channel: 'WHATSAPP',
      message: '15 to 19 Oct',
      requestId: 'req-3',
      idempotencyKey: 'wamid.DUP',
    });

    expect(result.messageId).toBe('msg-old');
    expect(mocks.appendMessageToConversation).not.toHaveBeenCalled();
  });

  it('saves the idempotency key when one is provided on a fresh request', async () => {
    await continueEnquiry(makeContinueDeps(), {
      tenantId: TENANT_ID,
      conversationId: 'conv-1',
      channel: 'WHATSAPP',
      message: '15 to 19 Oct',
      requestId: 'req-4',
      idempotencyKey: 'wamid.NEW',
    });

    expect(mocks.saveIdempotencyKey).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ key: 'wamid.NEW', tenantId: TENANT_ID }),
    );
  });
});
