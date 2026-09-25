import { createInitialJourneyContext, JourneyState, type TenantId } from '@ai-concierge/domain';
import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireJourneyLock,
  createJourney,
  findJourneyByConversationId,
  findJourneyTransitions,
  transitionJourney,
} from './journeyRepository.js';

async function seedConversation(prisma: PrismaClient, tenantId: TenantId) {
  return prisma.conversation.create({
    data: { tenantId, channel: 'WHATSAPP', customerRef: '+15550000001' },
  });
}

describe('journeyRepository', () => {
  let prisma: PrismaClient;

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
  });

  it('creates a journey in ENQUIRY_RECEIVED and records the initial transition', async () => {
    const conversation = await seedConversation(prisma, TEST_TENANT_ID);
    const journey = await prisma.$transaction(async (tx) => {
      await acquireJourneyLock(tx, TEST_TENANT_ID, conversation.id);
      return createJourney(tx, {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        context: createInitialJourneyContext(conversation.id),
      });
    });

    expect(journey.state).toBe(JourneyState.ENQUIRY_RECEIVED);
    expect(journey.version).toBe(0);

    const found = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
    expect(found?.id).toBe(journey.id);

    const transitions = await findJourneyTransitions(prisma, TEST_TENANT_ID, journey.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.fromState).toBeNull();
    expect(transitions[0]?.toState).toBe(JourneyState.ENQUIRY_RECEIVED);
  });

  it('transitions the journey and appends a transition row, incrementing version', async () => {
    const conversation = await seedConversation(prisma, TEST_TENANT_ID);
    const journey = await prisma.$transaction(async (tx) => {
      await acquireJourneyLock(tx, TEST_TENANT_ID, conversation.id);
      return createJourney(tx, {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        context: createInitialJourneyContext(conversation.id),
      });
    });

    const result = await prisma.$transaction(async (tx) => {
      await acquireJourneyLock(tx, TEST_TENANT_ID, conversation.id);
      return transitionJourney(tx, {
        tenantId: TEST_TENANT_ID,
        journeyId: journey.id,
        expectedVersion: journey.version,
        toState: JourneyState.EXTRACTING_REQUIREMENTS,
        context: journey.context,
        actor: 'AI',
        reason: 'intent recognized',
      });
    });

    expect(result.outcome).toBe('TRANSITIONED');
    if (result.outcome === 'TRANSITIONED') {
      expect(result.journey.state).toBe(JourneyState.EXTRACTING_REQUIREMENTS);
      expect(result.journey.version).toBe(1);
    }

    const transitions = await findJourneyTransitions(prisma, TEST_TENANT_ID, journey.id);
    expect(transitions).toHaveLength(2);
    expect(transitions[1]?.fromState).toBe(JourneyState.ENQUIRY_RECEIVED);
    expect(transitions[1]?.toState).toBe(JourneyState.EXTRACTING_REQUIREMENTS);
  });

  it('returns VERSION_CONFLICT instead of transitioning on a stale expected version', async () => {
    const conversation = await seedConversation(prisma, TEST_TENANT_ID);
    const journey = await prisma.$transaction(async (tx) => {
      await acquireJourneyLock(tx, TEST_TENANT_ID, conversation.id);
      return createJourney(tx, {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        context: createInitialJourneyContext(conversation.id),
      });
    });

    const staleVersion = journey.version + 5;
    const result = await prisma.$transaction(async (tx) => {
      await acquireJourneyLock(tx, TEST_TENANT_ID, conversation.id);
      return transitionJourney(tx, {
        tenantId: TEST_TENANT_ID,
        journeyId: journey.id,
        expectedVersion: staleVersion,
        toState: JourneyState.EXTRACTING_REQUIREMENTS,
        context: journey.context,
        actor: 'AI',
        reason: 'x',
      });
    });

    expect(result.outcome).toBe('VERSION_CONFLICT');
    const unchanged = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
    expect(unchanged?.state).toBe(JourneyState.ENQUIRY_RECEIVED);
  });

  it('the advisory lock serializes concurrent lock-read-transition attempts so no update is lost (10-way race)', async () => {
    const conversation = await seedConversation(prisma, TEST_TENANT_ID);
    const journey = await prisma.$transaction(async (tx) => {
      await acquireJourneyLock(tx, TEST_TENANT_ID, conversation.id);
      return createJourney(tx, {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        context: createInitialJourneyContext(conversation.id),
      });
    });

    // Each attempt follows the real caller discipline (journeyService.ts):
    // acquire the lock first, *then* read the current version, *then* write.
    // With that discipline the lock alone prevents a lost update — every one
    // of the 10 concurrent attempts should succeed in some serialized order,
    // never see a stale version, and never silently overwrite another's
    // write. (A version conflict is only reachable when a caller reads
    // *outside* the lock, as the previous test proves directly.)
    const attempts = Array.from({ length: 10 }, () =>
      prisma.$transaction(async (tx) => {
        await acquireJourneyLock(tx, TEST_TENANT_ID, conversation.id);
        const current = await findJourneyByConversationId(tx, TEST_TENANT_ID, conversation.id);
        if (!current) throw new Error('journey vanished');
        return transitionJourney(tx, {
          tenantId: TEST_TENANT_ID,
          journeyId: journey.id,
          expectedVersion: current.version,
          toState: JourneyState.EXTRACTING_REQUIREMENTS,
          context: current.context,
          actor: 'AI',
          reason: 'concurrent attempt',
        });
      }),
    );

    const results = await Promise.all(attempts);
    expect(results.every((r) => r.outcome === 'TRANSITIONED')).toBe(true);

    const final = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
    expect(final?.state).toBe(JourneyState.EXTRACTING_REQUIREMENTS);
    // Every attempt legally incremented the version once, serialized by the lock.
    expect(final?.version).toBe(10);

    const transitions = await findJourneyTransitions(prisma, TEST_TENANT_ID, journey.id);
    expect(transitions).toHaveLength(11); // 1 creation + 10 transitions
  });
});
