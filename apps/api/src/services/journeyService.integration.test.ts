import {
  createTestPrismaClient,
  seedTestTenants,
  seedTestUser,
  truncateAllTables,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import {
  findEscalationCaseById,
  findJourneyByConversationId,
  findJourneyTransitions,
  listEscalationCases,
  type PrismaClient,
} from '@ai-concierge/db';
import {
  EligibilityDecisionStatus,
  InventoryStatus,
  JourneyState,
  MissingInfoStatus,
  QuoteStatus,
} from '@ai-concierge/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeNotificationProvider } from '../test/fakeNotificationProvider.js';
import {
  recordAlternativesOutcome,
  recordAvailabilityOutcome,
  recordEligibilityOutcome,
  recordQuoteOutcome,
  syncJourneyAfterMissingInfo,
} from './journeyService.js';

async function seedConversation(prisma: PrismaClient) {
  return prisma.conversation.create({
    data: { tenantId: TEST_TENANT_ID, channel: 'WHATSAPP', customerRef: '+15550007777' },
  });
}

async function seedMessage(prisma: PrismaClient, conversationId: string) {
  return prisma.message.create({ data: { conversationId, content: 'test message' } });
}

describe('journeyService', () => {
  let prisma: PrismaClient;
  let notificationProvider: FakeNotificationProvider;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedTestTenants(prisma);
    notificationProvider = new FakeNotificationProvider();
  });

  describe('syncJourneyAfterMissingInfo', () => {
    it('creates a journey and fast-forwards to ELIGIBILITY_CHECK on a COMPLETE result', async () => {
      const conversation = await seedConversation(prisma);
      const message = await seedMessage(prisma, conversation.id);

      const journey = await syncJourneyAfterMissingInfo(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          messageId: message.id,
          resolvedVehicleId: null,
          missingInfoStatus: MissingInfoStatus.COMPLETE,
          requestId: 'req-1',
        },
      );

      expect(journey.state).toBe(JourneyState.ELIGIBILITY_CHECK);
      const transitions = await findJourneyTransitions(prisma, TEST_TENANT_ID, journey.id);
      expect(transitions.map((t) => t.toState)).toEqual([
        JourneyState.ENQUIRY_RECEIVED,
        JourneyState.EXTRACTING_REQUIREMENTS,
        JourneyState.VEHICLE_SELECTION,
        JourneyState.COLLECTING_MISSING_INFO,
        JourneyState.ELIGIBILITY_CHECK,
      ]);
    });

    it('loops at COLLECTING_MISSING_INFO on NEEDS_INFO, incrementing the attempt counter', async () => {
      const conversation = await seedConversation(prisma);
      const message = await seedMessage(prisma, conversation.id);
      const input = {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        messageId: message.id,
        resolvedVehicleId: null,
        missingInfoStatus: MissingInfoStatus.NEEDS_INFO,
        requestId: 'req-1',
      } as const;

      const first = await syncJourneyAfterMissingInfo({ prisma, notificationProvider }, input);
      expect(first.state).toBe(JourneyState.COLLECTING_MISSING_INFO);
      expect(first.context.missingInfoAttempts).toBe(1);

      const second = await syncJourneyAfterMissingInfo({ prisma, notificationProvider }, input);
      expect(second.state).toBe(JourneyState.COLLECTING_MISSING_INFO);
      expect(second.context.missingInfoAttempts).toBe(2);
      expect(notificationProvider.sent).toHaveLength(0);
    });

    it('escalates to T2 (MISSING_INFO_STALLED) on the 3rd consecutive NEEDS_INFO and pages OPS_AGENT staff', async () => {
      const worker = await seedTestUser(prisma, {
        tenantId: TEST_TENANT_ID,
        role: 'OPS_AGENT',
        email: 'ops-worker@example.com',
      });
      await prisma.user.update({ where: { id: worker.id }, data: { phone: '+15550001234' } });

      const conversation = await seedConversation(prisma);
      const message = await seedMessage(prisma, conversation.id);
      const input = {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        messageId: message.id,
        resolvedVehicleId: null,
        missingInfoStatus: MissingInfoStatus.NEEDS_INFO,
        requestId: 'req-1',
      } as const;

      await syncJourneyAfterMissingInfo({ prisma, notificationProvider }, input);
      await syncJourneyAfterMissingInfo({ prisma, notificationProvider }, input);
      const third = await syncJourneyAfterMissingInfo({ prisma, notificationProvider }, input);

      expect(third.state).toBe(JourneyState.ESCALATED);
      const cases = await listEscalationCases(prisma, {
        tenantId: TEST_TENANT_ID,
        status: 'OPEN',
        limit: 10,
        offset: 0,
      });
      expect(cases).toHaveLength(1);
      expect(cases[0]?.tier).toBe('T2');
      expect(cases[0]?.reason).toBe('MISSING_INFO_STALLED');

      expect(notificationProvider.sent).toHaveLength(1);
      expect(notificationProvider.sent[0]?.to).toBe('+15550001234');
    });

    it('a journey already ESCALATED is left untouched by a further sync call', async () => {
      await seedTestUser(prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
      const conversation = await seedConversation(prisma);
      const message = await seedMessage(prisma, conversation.id);
      const input = {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        messageId: message.id,
        resolvedVehicleId: null,
        missingInfoStatus: MissingInfoStatus.NEEDS_INFO,
        requestId: 'req-1',
      } as const;
      await syncJourneyAfterMissingInfo({ prisma, notificationProvider }, input);
      await syncJourneyAfterMissingInfo({ prisma, notificationProvider }, input);
      const escalated = await syncJourneyAfterMissingInfo({ prisma, notificationProvider }, input);
      expect(escalated.state).toBe(JourneyState.ESCALATED);

      const untouched = await syncJourneyAfterMissingInfo(
        { prisma, notificationProvider },
        { ...input, missingInfoStatus: MissingInfoStatus.COMPLETE },
      );
      expect(untouched.state).toBe(JourneyState.ESCALATED);
      expect(untouched.version).toBe(escalated.version);
    });

    it('transitions to EXPIRED on an EXPIRED result', async () => {
      const conversation = await seedConversation(prisma);
      const message = await seedMessage(prisma, conversation.id);
      const journey = await syncJourneyAfterMissingInfo(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          messageId: message.id,
          resolvedVehicleId: null,
          missingInfoStatus: MissingInfoStatus.EXPIRED,
          requestId: 'req-1',
        },
      );
      expect(journey.state).toBe(JourneyState.EXPIRED);
    });
  });

  describe('recordEligibilityOutcome', () => {
    async function journeyAtEligibilityCheck(prisma: PrismaClient) {
      const conversation = await seedConversation(prisma);
      const message = await seedMessage(prisma, conversation.id);
      const journey = await syncJourneyAfterMissingInfo(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          messageId: message.id,
          resolvedVehicleId: null,
          missingInfoStatus: MissingInfoStatus.COMPLETE,
          requestId: 'req-1',
        },
      );
      return { conversation, journey };
    }

    it('advances to AVAILABILITY_CHECK when ELIGIBLE', async () => {
      const { conversation } = await journeyAtEligibilityCheck(prisma);
      await recordEligibilityOutcome(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          status: EligibilityDecisionStatus.ELIGIBLE,
          reason: 'ok',
          requestId: 'req-2',
        },
      );
      const journey = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
      expect(journey?.state).toBe(JourneyState.AVAILABILITY_CHECK);
    });

    it('escalates to T3 when NEEDS_HUMAN_REVIEW', async () => {
      const worker = await seedTestUser(prisma, {
        tenantId: TEST_TENANT_ID,
        role: 'MANAGER',
        email: 'manager@example.com',
      });
      await prisma.user.update({ where: { id: worker.id }, data: { phone: '+15559998888' } });
      const { conversation } = await journeyAtEligibilityCheck(prisma);

      await recordEligibilityOutcome(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          status: EligibilityDecisionStatus.NEEDS_HUMAN_REVIEW,
          reason: 'high-risk nationality exception',
          requestId: 'req-2',
        },
      );

      const journey = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
      expect(journey?.state).toBe(JourneyState.ESCALATED);
      const openCase = await listEscalationCases(prisma, {
        tenantId: TEST_TENANT_ID,
        status: 'OPEN',
        limit: 10,
        offset: 0,
      });
      expect(openCase[0]?.tier).toBe('T3');
      expect(openCase[0]?.reason).toBe('ELIGIBILITY_NEEDS_REVIEW');
      expect(notificationProvider.sent[0]?.to).toBe('+15559998888');
    });

    it('transitions to DECLINED when INELIGIBLE (no escalation — a normal outcome)', async () => {
      const { conversation } = await journeyAtEligibilityCheck(prisma);
      await recordEligibilityOutcome(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          status: EligibilityDecisionStatus.INELIGIBLE,
          reason: 'underage',
          requestId: 'req-2',
        },
      );
      const journey = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
      expect(journey?.state).toBe(JourneyState.DECLINED);
      expect(notificationProvider.sent).toHaveLength(0);
    });

    it('is a silent no-op when no journey exists for the conversation', async () => {
      const conversation = await seedConversation(prisma);
      await expect(
        recordEligibilityOutcome(
          { prisma, notificationProvider },
          {
            tenantId: TEST_TENANT_ID,
            conversationId: conversation.id,
            status: EligibilityDecisionStatus.ELIGIBLE,
            reason: 'ok',
            requestId: 'req-2',
          },
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('recordAvailabilityOutcome + recordAlternativesOutcome', () => {
    async function journeyAtAvailabilityCheck(prisma: PrismaClient) {
      const conversation = await seedConversation(prisma);
      const message = await seedMessage(prisma, conversation.id);
      await syncJourneyAfterMissingInfo(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          messageId: message.id,
          resolvedVehicleId: null,
          missingInfoStatus: MissingInfoStatus.COMPLETE,
          requestId: 'req-1',
        },
      );
      await recordEligibilityOutcome(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          status: EligibilityDecisionStatus.ELIGIBLE,
          reason: 'ok',
          requestId: 'req-2',
        },
      );
      return conversation;
    }

    it('leaves the journey at AVAILABILITY_CHECK on AVAILABLE (that state is the "ready for quote" resting point)', async () => {
      const conversation = await journeyAtAvailabilityCheck(prisma);
      await recordAvailabilityOutcome(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          status: InventoryStatus.AVAILABLE,
          retryable: false,
          reason: null,
          requestId: 'req-3',
        },
      );
      const journey = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
      expect(journey?.state).toBe(JourneyState.AVAILABILITY_CHECK);
    });

    it('moves to OFFERING_ALTERNATIVES on UNAVAILABLE', async () => {
      const conversation = await journeyAtAvailabilityCheck(prisma);
      await recordAvailabilityOutcome(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          status: InventoryStatus.UNAVAILABLE,
          retryable: false,
          reason: null,
          requestId: 'req-3',
        },
      );
      const journey = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
      expect(journey?.state).toBe(JourneyState.OFFERING_ALTERNATIVES);
    });

    it('escalates to T2 on a retryable UNKNOWN (provider failure)', async () => {
      const worker = await seedTestUser(prisma, {
        tenantId: TEST_TENANT_ID,
        role: 'OPS_AGENT',
        email: 'ops2@example.com',
      });
      await prisma.user.update({ where: { id: worker.id }, data: { phone: '+15551112222' } });
      const conversation = await journeyAtAvailabilityCheck(prisma);

      await recordAvailabilityOutcome(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          status: InventoryStatus.UNKNOWN,
          retryable: true,
          reason: 'fleet provider timeout',
          requestId: 'req-3',
        },
      );
      const journey = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
      expect(journey?.state).toBe(JourneyState.ESCALATED);
      expect(notificationProvider.sent[0]?.to).toBe('+15551112222');
    });

    it('recordAlternativesOutcome hops AVAILABILITY_CHECK -> OFFERING_ALTERNATIVES, and a re-check hops back', async () => {
      const conversation = await journeyAtAvailabilityCheck(prisma);
      await recordAlternativesOutcome(
        { prisma, notificationProvider },
        { tenantId: TEST_TENANT_ID, conversationId: conversation.id },
      );
      let journey = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
      expect(journey?.state).toBe(JourneyState.OFFERING_ALTERNATIVES);

      await recordAvailabilityOutcome(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          status: InventoryStatus.AVAILABLE,
          retryable: false,
          reason: null,
          requestId: 'req-4',
        },
      );
      journey = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
      expect(journey?.state).toBe(JourneyState.AVAILABILITY_CHECK);
    });
  });

  describe('recordQuoteOutcome', () => {
    async function journeyAtAvailabilityCheck(prisma: PrismaClient) {
      const conversation = await seedConversation(prisma);
      const message = await seedMessage(prisma, conversation.id);
      await syncJourneyAfterMissingInfo(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          messageId: message.id,
          resolvedVehicleId: null,
          missingInfoStatus: MissingInfoStatus.COMPLETE,
          requestId: 'req-1',
        },
      );
      await recordEligibilityOutcome(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          status: EligibilityDecisionStatus.ELIGIBLE,
          reason: 'ok',
          requestId: 'req-2',
        },
      );
      return conversation;
    }

    it('transitions to QUOTE_ISSUED on ISSUED', async () => {
      const conversation = await journeyAtAvailabilityCheck(prisma);
      await recordQuoteOutcome(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          status: QuoteStatus.ISSUED,
          reviewReasons: [],
          requestId: 'req-3',
        },
      );
      const journey = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
      expect(journey?.state).toBe(JourneyState.QUOTE_ISSUED);
    });

    it('escalates to T3 on PENDING_REVIEW, carrying the review reasons as the case detail', async () => {
      const worker = await seedTestUser(prisma, {
        tenantId: TEST_TENANT_ID,
        role: 'MANAGER',
        email: 'manager2@example.com',
      });
      await prisma.user.update({ where: { id: worker.id }, data: { phone: '+15553334444' } });
      const conversation = await journeyAtAvailabilityCheck(prisma);

      await recordQuoteOutcome(
        { prisma, notificationProvider },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: conversation.id,
          status: QuoteStatus.PENDING_REVIEW,
          reviewReasons: ['large discount'],
          requestId: 'req-3',
        },
      );

      const journey = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
      expect(journey?.state).toBe(JourneyState.ESCALATED);
      const openCase = await listEscalationCases(prisma, {
        tenantId: TEST_TENANT_ID,
        status: 'OPEN',
        limit: 10,
        offset: 0,
      });
      expect(openCase[0]?.detail).toBe('large discount');
      const fetched = await findEscalationCaseById(prisma, TEST_TENANT_ID, openCase[0]!.id);
      expect(fetched?.reason).toBe('QUOTE_NEEDS_REVIEW');
    });
  });
});
