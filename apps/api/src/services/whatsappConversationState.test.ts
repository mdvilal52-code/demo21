import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntentResult } from '@ai-concierge/domain';

const mocks = vi.hoisted(() => ({
  extractDatesAndLocation: vi.fn(),
  determineVehicle: vi.fn(),
  createMissingInfoCheck: vi.fn(),
  findDateLocationExtractionsForConversation: vi.fn(),
  findVehicleDeterminationsForConversation: vi.fn(),
  toDomainVehicle: vi.fn((row: unknown) => row),
  auditRecord: vi.fn(),
  evaluate: vi.fn(),
}));

vi.mock('./dateLocationService.js', () => ({
  extractDatesAndLocation: mocks.extractDatesAndLocation,
}));
vi.mock('./vehicleService.js', () => ({ determineVehicle: mocks.determineVehicle }));
vi.mock('@ai-concierge/db', () => ({
  createMissingInfoCheck: mocks.createMissingInfoCheck,
  findDateLocationExtractionsForConversation: mocks.findDateLocationExtractionsForConversation,
  findVehicleDeterminationsForConversation: mocks.findVehicleDeterminationsForConversation,
  toDomainVehicle: mocks.toDomainVehicle,
  PrismaAuditWriter: class {
    record = mocks.auditRecord;
  },
}));

const { advanceWhatsAppConversation } = await import('./whatsappConversationState.js');

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const CONVERSATION_ID = '00000000-0000-0000-0000-0000000000c1';
const CYCLE_STARTED_AT = new Date('2026-09-20T10:00:00.000Z');

function makeIntent(overrides: Partial<IntentResult> = {}): IntentResult {
  return {
    intentType: 'UNKNOWN',
    status: 'RECOGNIZED',
    confidence: 0.9,
    entities: { language: 'en', urgency: 'LOW' },
    missingFields: [],
    flags: { promptInjectionDetected: false },
    modelMetadata: { engine: 'rule-based-v1', version: '0.1.0', deterministic: true },
    ...overrides,
  };
}

function makeDeps() {
  return {
    prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})) },
    dateLocationOrchestrator: {},
    vehicleOrchestrator: {},
    missingInfoOrchestrator: { evaluate: mocks.evaluate },
  } as never;
}

function baseCtx(overrides: Partial<Parameters<typeof advanceWhatsAppConversation>[1]> = {}) {
  return {
    tenantId: TENANT_ID,
    requestId: 'req-1',
    conversationId: CONVERSATION_ID,
    stage: 'NEW' as const,
    cycleStartedAt: CYCLE_STARTED_AT,
    intent: makeIntent(),
    messageText: 'Hiii',
    ...overrides,
  };
}

const NEEDS_INFO_RESULT = {
  status: 'NEEDS_INFO',
  collected: {
    pickupDate: null,
    returnDate: null,
    pickupLocation: null,
    dropoffLocation: null,
    vehicle: null,
  },
  missingFields: [{ field: 'PICKUP_DATE', reason: 'NOT_PROVIDED' }],
  clarificationPrompt: 'When would you like to pick up the car?',
  expiresAt: '2026-09-21T10:00:00.000Z',
  flags: { promptInjectionDetectedAnywhere: false },
  modelMetadata: { engine: 'missing-info-evaluator-v1', version: '0.1.0', deterministic: true },
};

describe('advanceWhatsAppConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findVehicleDeterminationsForConversation.mockResolvedValue([]);
    mocks.findDateLocationExtractionsForConversation.mockResolvedValue([]);
    mocks.extractDatesAndLocation.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      messageId: 'msg-latest',
      extraction: {},
    });
    mocks.determineVehicle.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      messageId: 'msg-latest',
      determination: {},
    });
    mocks.evaluate.mockReturnValue(NEEDS_INFO_RESULT);
  });

  describe('stage NEW', () => {
    it('sends the booking invitation and moves to AWAITING_BOOKING_CONFIRMATION for a plain greeting', async () => {
      const outcome = await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({ stage: 'NEW', messageText: 'Hiii' }),
      );

      expect(outcome.nextStage).toBe('AWAITING_BOOKING_CONFIRMATION');
      expect(outcome.replyText).toMatch(/book a car/i);
      expect(outcome.nextCycleStartedAt).toBe(CYCLE_STARTED_AT);
      expect(mocks.extractDatesAndLocation).not.toHaveBeenCalled();
      expect(mocks.determineVehicle).not.toHaveBeenCalled();
      expect(mocks.evaluate).not.toHaveBeenCalled();
    });

    it('runs the booking pipeline immediately when the very first message is already booking-shaped', async () => {
      const outcome = await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({
          stage: 'NEW',
          intent: makeIntent({ intentType: 'BOOKING_REQUEST' }),
          messageText: 'I want to rent a car',
        }),
      );

      expect(mocks.extractDatesAndLocation).toHaveBeenCalled();
      expect(mocks.determineVehicle).toHaveBeenCalled();
      expect(mocks.evaluate).toHaveBeenCalled();
      expect(outcome.replyText).toBe(NEEDS_INFO_RESULT.clarificationPrompt);
      // NEEDS_INFO_RESULT's only missing field is PICKUP_DATE — the vehicle
      // isn't missing, so this moves past vehicle collection already.
      expect(outcome.nextStage).toBe('COLLECTING_DETAILS');
    });

    it('scopes the merge query to the current cycle (since: cycleStartedAt)', async () => {
      await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({ stage: 'NEW', intent: makeIntent({ intentType: 'BOOKING_REQUEST' }) }),
      );

      expect(mocks.findDateLocationExtractionsForConversation).toHaveBeenCalledWith(
        expect.anything(),
        TENANT_ID,
        CONVERSATION_ID,
        CYCLE_STARTED_AT,
      );
      expect(mocks.findVehicleDeterminationsForConversation).toHaveBeenCalledWith(
        expect.anything(),
        TENANT_ID,
        CONVERSATION_ID,
        CYCLE_STARTED_AT,
      );
      expect(mocks.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ conversationCreatedAt: CYCLE_STARTED_AT }),
      );
    });
  });

  describe('stage AWAITING_BOOKING_CONFIRMATION', () => {
    const stage = 'AWAITING_BOOKING_CONFIRMATION' as const;

    it('asks which car and moves to COLLECTING_VEHICLE for "Yes" — never repeats the greeting', async () => {
      const outcome = await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({ stage, messageText: 'Yes' }),
      );

      expect(outcome.nextStage).toBe('COLLECTING_VEHICLE');
      expect(outcome.replyText).toMatch(/which car/i);
      expect(outcome.replyText).not.toMatch(/book a car and we'll take it from there/i);
      expect(mocks.evaluate).not.toHaveBeenCalled();
    });

    it.each(['yeah', 'Sure', 'Okay', 'yep'])('also treats %j as affirmative', async (reply) => {
      const outcome = await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({ stage, messageText: reply }),
      );
      expect(outcome.nextStage).toBe('COLLECTING_VEHICLE');
    });

    it('declines gracefully and resets to NEW for "No"', async () => {
      const outcome = await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({ stage, messageText: 'No thanks' }),
      );
      expect(outcome.nextStage).toBe('NEW');
      expect(outcome.replyText).toMatch(/no problem/i);
    });

    it('nudges (not the original greeting) and stays in the same stage for an unclear reply', async () => {
      const outcome = await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({ stage, messageText: 'hmm what' }),
      );
      expect(outcome.nextStage).toBe(stage);
      expect(outcome.replyText).not.toMatch(/book a car and we'll take it from there/i);
    });

    it('skips the confirmation question when the customer names a vehicle directly', async () => {
      const outcome = await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({
          stage,
          intent: makeIntent({
            entities: { language: 'en', urgency: 'LOW', vehicleIntent: 'lamborghini' },
          }),
          messageText: 'Lamborghini Urus please',
        }),
      );
      expect(mocks.determineVehicle).toHaveBeenCalled();
      expect(outcome.nextStage).not.toBe('AWAITING_BOOKING_CONFIRMATION');
    });
  });

  describe('stages COLLECTING_VEHICLE / COLLECTING_DETAILS', () => {
    it('acknowledges the resolved vehicle and asks for missing details', async () => {
      mocks.evaluate.mockReturnValue({
        ...NEEDS_INFO_RESULT,
        collected: {
          ...NEEDS_INFO_RESULT.collected,
          vehicle: { make: 'Lamborghini', model: 'Urus' },
        },
        missingFields: [{ field: 'PICKUP_DATE', reason: 'NOT_PROVIDED' }],
      });

      const outcome = await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({
          stage: 'COLLECTING_VEHICLE',
          intent: makeIntent({
            entities: { language: 'en', urgency: 'LOW', vehicleIntent: 'lamborghini' },
          }),
          messageText: 'Lamborghini Urus',
        }),
      );

      expect(outcome.replyText).toContain('Lamborghini Urus');
      expect(outcome.nextStage).toBe('COLLECTING_DETAILS');
    });

    it('stays in COLLECTING_VEHICLE when the vehicle is still missing', async () => {
      mocks.evaluate.mockReturnValue({
        ...NEEDS_INFO_RESULT,
        missingFields: [{ field: 'VEHICLE', reason: 'NOT_PROVIDED' }],
      });

      const outcome = await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({ stage: 'COLLECTING_VEHICLE', messageText: 'hmm not sure yet' }),
      );

      expect(outcome.nextStage).toBe('COLLECTING_VEHICLE');
    });

    it('always re-runs vehicle determination on the new message (never skips it)', async () => {
      mocks.findVehicleDeterminationsForConversation.mockResolvedValue([
        {
          status: 'RESOLVED',
          resolvedVehicle: { id: 'v1', make: 'Lamborghini', model: 'Urus' },
          ambiguities: [],
          validationErrors: [],
          flags: { promptInjectionDetected: false },
        },
      ]);

      await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({ stage: 'COLLECTING_DETAILS', messageText: 'pickup 15 Oct, Dubai Marina' }),
      );

      expect(mocks.determineVehicle).toHaveBeenCalled();
      expect(mocks.extractDatesAndLocation).toHaveBeenCalled();
    });

    it('lets a newer message correctly replace a previously resolved vehicle with a different one', async () => {
      // Oldest -> newest: Urus resolved first, then the customer changes
      // their mind and Ferrari resolves in a later message.
      mocks.findVehicleDeterminationsForConversation.mockResolvedValue([
        {
          status: 'RESOLVED',
          resolvedVehicle: { id: 'v1', make: 'Lamborghini', model: 'Urus' },
          ambiguities: [],
          validationErrors: [],
          flags: { promptInjectionDetected: false },
        },
        {
          status: 'RESOLVED',
          resolvedVehicle: { id: 'v2', make: 'Ferrari', model: '812' },
          ambiguities: [],
          validationErrors: [],
          flags: { promptInjectionDetected: false },
        },
      ]);
      mocks.evaluate.mockReturnValue(NEEDS_INFO_RESULT);

      await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({
          stage: 'COLLECTING_DETAILS',
          messageText: 'actually give me the Ferrari 812 instead',
        }),
      );

      expect(mocks.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          vehicle: expect.objectContaining({
            resolvedVehicle: { id: 'v2', make: 'Ferrari', model: '812' },
          }),
        }),
      );
    });

    it('an older resolution still survives a newer message that does not mention a vehicle at all', async () => {
      mocks.findVehicleDeterminationsForConversation.mockResolvedValue([
        {
          status: 'RESOLVED',
          resolvedVehicle: { id: 'v1', make: 'Lamborghini', model: 'Urus' },
          ambiguities: [],
          validationErrors: [],
          flags: { promptInjectionDetected: false },
        },
        {
          status: 'UNSUPPORTED',
          resolvedVehicle: null,
          ambiguities: [],
          validationErrors: [],
          flags: { promptInjectionDetected: false },
        },
      ]);

      await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({ stage: 'COLLECTING_DETAILS', messageText: 'pickup 15 Oct, Dubai Marina' }),
      );

      expect(mocks.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          vehicle: expect.objectContaining({
            resolvedVehicle: { id: 'v1', make: 'Lamborghini', model: 'Urus' },
          }),
        }),
      );
    });

    it('moves to COMPLETE when Step 4 reports everything is resolved', async () => {
      mocks.evaluate.mockReturnValue({
        ...NEEDS_INFO_RESULT,
        status: 'COMPLETE',
        missingFields: [],
        clarificationPrompt: null,
      });

      const outcome = await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({
          stage: 'COLLECTING_DETAILS',
          messageText: 'pickup 15 Oct, return 19 Oct, Dubai Marina',
        }),
      );

      expect(outcome.nextStage).toBe('COMPLETE');
    });
  });

  describe('stage COMPLETE', () => {
    it('is treated as a fresh cycle (booking invitation) for a new, unrelated message', async () => {
      const outcome = await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({ stage: 'COMPLETE', messageText: 'Hi again' }),
      );

      expect(outcome.nextStage).toBe('AWAITING_BOOKING_CONFIRMATION');
      expect(outcome.replyText).toMatch(/book a car/i);
    });

    it("resets cycleStartedAt to now, discarding the previous cycle's data from the merge", async () => {
      const outcome = await advanceWhatsAppConversation(
        makeDeps(),
        baseCtx({
          stage: 'COMPLETE',
          intent: makeIntent({ intentType: 'BOOKING_REQUEST' }),
          messageText: 'I want to rent a car again',
        }),
      );

      expect(outcome.nextCycleStartedAt).not.toEqual(CYCLE_STARTED_AT);
      expect(outcome.nextCycleStartedAt.getTime()).toBeGreaterThan(CYCLE_STARTED_AT.getTime());
      expect(mocks.findDateLocationExtractionsForConversation).toHaveBeenCalledWith(
        expect.anything(),
        TENANT_ID,
        CONVERSATION_ID,
        outcome.nextCycleStartedAt,
      );
    });
  });
});
