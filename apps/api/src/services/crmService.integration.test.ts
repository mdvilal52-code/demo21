import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import {
  acquireJourneyLock,
  createJourney,
  findCustomerTimeline,
  listCustomers,
  type PrismaClient,
} from '@ai-concierge/db';
import { createInitialJourneyContext, CustomerTimelineEventType } from '@ai-concierge/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncCustomerFromJourney } from './crmService.js';

async function seedConversationAndJourney(prisma: PrismaClient) {
  const conversation = await prisma.conversation.create({
    data: { tenantId: TEST_TENANT_ID, channel: 'WHATSAPP', customerRef: '+15550006666' },
  });
  const journey = await prisma.$transaction(async (tx) => {
    await acquireJourneyLock(tx, TEST_TENANT_ID, conversation.id);
    return createJourney(tx, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      context: createInitialJourneyContext(conversation.id),
    });
  });
  return { conversation, journey };
}

describe('crmService', () => {
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

  it('creates a customer and a timeline event on the first sync', async () => {
    const { conversation, journey } = await seedConversationAndJourney(prisma);

    const customer = await syncCustomerFromJourney(
      { prisma },
      {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        journeyId: journey.id,
        eventType: CustomerTimelineEventType.JOURNEY_STARTED,
        eventSummary: 'Journey started on WhatsApp',
        vehicleId: null,
        quoteId: null,
        bookingCompleted: false,
      },
    );

    expect(customer.channel).toBe('WHATSAPP');
    expect(customer.customerRef).toBe('+15550006666');
    expect(customer.bookingCount).toBe(0);

    const customers = await listCustomers(prisma, {
      tenantId: TEST_TENANT_ID,
      limit: 10,
      offset: 0,
    });
    expect(customers).toHaveLength(1);

    const timeline = await findCustomerTimeline(prisma, TEST_TENANT_ID, customer.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.type).toBe(CustomerTimelineEventType.JOURNEY_STARTED);
    expect(timeline[0]?.journeyId).toBe(journey.id);
  });

  it('a second sync updates the same customer row and appends a second timeline event', async () => {
    const { conversation, journey } = await seedConversationAndJourney(prisma);
    const vehicleId = '22222222-2222-2222-2222-222222222222';
    const quoteId = '33333333-3333-3333-3333-333333333333';

    await syncCustomerFromJourney(
      { prisma },
      {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        journeyId: journey.id,
        eventType: CustomerTimelineEventType.JOURNEY_STARTED,
        eventSummary: 'Journey started',
        vehicleId: null,
        quoteId: null,
        bookingCompleted: false,
      },
    );
    const afterQuote = await syncCustomerFromJourney(
      { prisma },
      {
        tenantId: TEST_TENANT_ID,
        conversationId: conversation.id,
        journeyId: journey.id,
        eventType: CustomerTimelineEventType.QUOTE_ISSUED,
        eventSummary: 'Quote issued: 12600 AED',
        vehicleId,
        quoteId,
        bookingCompleted: true,
      },
    );

    expect(afterQuote.lastVehicleId).toBe(vehicleId);
    expect(afterQuote.lastQuoteId).toBe(quoteId);
    expect(afterQuote.bookingCount).toBe(1);

    const customers = await listCustomers(prisma, {
      tenantId: TEST_TENANT_ID,
      limit: 10,
      offset: 0,
    });
    expect(customers).toHaveLength(1); // still one row, not a duplicate

    const timeline = await findCustomerTimeline(prisma, TEST_TENANT_ID, afterQuote.id);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.type).toBe(CustomerTimelineEventType.QUOTE_ISSUED); // newest first
  });

  it('throws NOT_FOUND for a conversation that does not exist', async () => {
    await expect(
      syncCustomerFromJourney(
        { prisma },
        {
          tenantId: TEST_TENANT_ID,
          conversationId: '11111111-1111-1111-1111-111111111111',
          journeyId: '22222222-2222-2222-2222-222222222222',
          eventType: CustomerTimelineEventType.JOURNEY_STARTED,
          eventSummary: 'x',
          vehicleId: null,
          quoteId: null,
          bookingCompleted: false,
        },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
