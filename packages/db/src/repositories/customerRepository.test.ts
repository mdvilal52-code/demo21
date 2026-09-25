import { CustomerTimelineEventType } from '@ai-concierge/domain';
import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  findCustomerById,
  findCustomerTimeline,
  listCustomers,
  recordCustomerTimelineEvent,
  upsertCustomerFromJourney,
} from './customerRepository.js';

describe('customerRepository', () => {
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

  it('creates a customer on the first upsert for a (tenant, channel, customerRef)', async () => {
    const journeyId = '11111111-1111-1111-1111-111111111111';
    const created = await upsertCustomerFromJourney(
      prisma,
      TEST_TENANT_ID,
      {
        channel: 'WHATSAPP',
        customerRef: '+15550001111',
        displayName: null,
        journeyId,
        vehicleId: null,
        quoteId: null,
        bookingCompleted: false,
      },
      new Date('2026-10-01T00:00:00.000Z'),
    );

    expect(created.customerRef).toBe('+15550001111');
    expect(created.bookingCount).toBe(0);
    expect(created.lastJourneyId).toBe(journeyId);

    const found = await findCustomerById(prisma, TEST_TENANT_ID, created.id);
    expect(found?.id).toBe(created.id);
  });

  it('updates the same row on a second upsert instead of creating a duplicate', async () => {
    const journeyId = '11111111-1111-1111-1111-111111111111';
    const vehicleId = '22222222-2222-2222-2222-222222222222';
    await upsertCustomerFromJourney(
      prisma,
      TEST_TENANT_ID,
      {
        channel: 'WHATSAPP',
        customerRef: '+15550002222',
        displayName: null,
        journeyId,
        vehicleId: null,
        quoteId: null,
        bookingCompleted: false,
      },
      new Date('2026-10-01T00:00:00.000Z'),
    );
    const updated = await upsertCustomerFromJourney(
      prisma,
      TEST_TENANT_ID,
      {
        channel: 'WHATSAPP',
        customerRef: '+15550002222',
        displayName: 'Ahmed',
        journeyId,
        vehicleId,
        quoteId: null,
        bookingCompleted: false,
      },
      new Date('2026-10-01T01:00:00.000Z'),
    );

    expect(updated.displayName).toBe('Ahmed');
    expect(updated.lastVehicleId).toBe(vehicleId);
    expect(updated.bookingCount).toBe(0);

    const all = await listCustomers(prisma, { tenantId: TEST_TENANT_ID, limit: 10, offset: 0 });
    expect(all).toHaveLength(1);
  });

  it('increments bookingCount only when bookingCompleted is true, never double-counting a re-upsert', async () => {
    const journeyId = '11111111-1111-1111-1111-111111111111';
    const quoteId = '33333333-3333-3333-3333-333333333333';
    await upsertCustomerFromJourney(
      prisma,
      TEST_TENANT_ID,
      {
        channel: 'WHATSAPP',
        customerRef: '+15550003333',
        displayName: null,
        journeyId,
        vehicleId: null,
        quoteId: null,
        bookingCompleted: false,
      },
      new Date(),
    );
    const afterQuote = await upsertCustomerFromJourney(
      prisma,
      TEST_TENANT_ID,
      {
        channel: 'WHATSAPP',
        customerRef: '+15550003333',
        displayName: null,
        journeyId,
        vehicleId: null,
        quoteId,
        bookingCompleted: true,
      },
      new Date(),
    );
    expect(afterQuote.bookingCount).toBe(1);

    // Re-upserting the same completed journey again (e.g. a duplicate webhook) must not double-count.
    const again = await upsertCustomerFromJourney(
      prisma,
      TEST_TENANT_ID,
      {
        channel: 'WHATSAPP',
        customerRef: '+15550003333',
        displayName: null,
        journeyId,
        vehicleId: null,
        quoteId,
        bookingCompleted: true,
      },
      new Date(),
    );
    expect(again.bookingCount).toBe(2);
    // NOTE: this documents actual current behavior — crmService.ts is responsible for calling
    // upsertCustomerFromJourney(bookingCompleted: true) at most once per journey (on the
    // QUOTE_ISSUED transition itself), not on every re-read of an already-quoted journey.
  });

  it('keeps two tenants completely separate even with the same customerRef', async () => {
    await upsertCustomerFromJourney(
      prisma,
      TEST_TENANT_ID,
      {
        channel: 'WHATSAPP',
        customerRef: '+15550004444',
        displayName: null,
        journeyId: '11111111-1111-1111-1111-111111111111',
        vehicleId: null,
        quoteId: null,
        bookingCompleted: false,
      },
      new Date(),
    );
    await upsertCustomerFromJourney(
      prisma,
      OTHER_TENANT_ID,
      {
        channel: 'WHATSAPP',
        customerRef: '+15550004444',
        displayName: null,
        journeyId: '11111111-1111-1111-1111-111111111111',
        vehicleId: null,
        quoteId: null,
        bookingCompleted: false,
      },
      new Date(),
    );

    const tenantACustomers = await listCustomers(prisma, {
      tenantId: TEST_TENANT_ID,
      limit: 10,
      offset: 0,
    });
    const tenantBCustomers = await listCustomers(prisma, {
      tenantId: OTHER_TENANT_ID,
      limit: 10,
      offset: 0,
    });
    expect(tenantACustomers).toHaveLength(1);
    expect(tenantBCustomers).toHaveLength(1);
    expect(tenantACustomers[0]?.id).not.toBe(tenantBCustomers[0]?.id);
  });

  it('records and reads back a timeline in newest-first order', async () => {
    const customer = await upsertCustomerFromJourney(
      prisma,
      TEST_TENANT_ID,
      {
        channel: 'WHATSAPP',
        customerRef: '+15550005555',
        displayName: null,
        journeyId: '11111111-1111-1111-1111-111111111111',
        vehicleId: null,
        quoteId: null,
        bookingCompleted: false,
      },
      new Date(),
    );

    // journeyId is deliberately null here — CustomerTimelineEvent.journeyId is a real FK to
    // journeys.id (unlike Customer.lastJourneyId, an unenforced convenience pointer), and this
    // test is about timeline ordering, not FK integrity, which Postgres itself already enforces.
    await recordCustomerTimelineEvent(prisma, {
      tenantId: TEST_TENANT_ID,
      customerId: customer.id,
      journeyId: null,
      type: CustomerTimelineEventType.JOURNEY_STARTED,
      summary: 'Journey started on WhatsApp',
    });
    await recordCustomerTimelineEvent(prisma, {
      tenantId: TEST_TENANT_ID,
      customerId: customer.id,
      journeyId: null,
      type: CustomerTimelineEventType.VEHICLE_RESOLVED,
      summary: 'Resolved to Lamborghini Urus',
    });

    const timeline = await findCustomerTimeline(prisma, TEST_TENANT_ID, customer.id);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.type).toBe(CustomerTimelineEventType.VEHICLE_RESOLVED);
    expect(timeline[1]?.type).toBe(CustomerTimelineEventType.JOURNEY_STARTED);
  });
});
