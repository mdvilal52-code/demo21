import { Prisma, type PrismaClient, type Customer as PrismaCustomer } from '@prisma/client';
import {
  customerSchema,
  type Customer,
  type CustomerTimelineEventTypeValue,
  type TenantId,
  type UpsertCustomerFromJourneyInput,
} from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export function toDomainCustomer(row: PrismaCustomer): Customer {
  return customerSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    channel: row.channel,
    customerRef: row.customerRef,
    displayName: row.displayName,
    lastVehicleId: row.lastVehicleId,
    lastQuoteId: row.lastQuoteId,
    bookingCount: row.bookingCount,
    lastJourneyId: row.lastJourneyId,
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * CRM auto-update (MASTER-PLAN.md §5 Phase 5: "CRM adapter (internal
 * default)") — an upsert keyed on the same (tenantId, channel, customerRef)
 * identity `findOpenConversationForCustomer` uses, called by
 * `crmService.ts` after every journey-advancing step, never hand-entered.
 * `bookingCount` only increments when `bookingCompleted` is true (Quote
 * issued) — a repeated call for the same in-progress journey (e.g. after
 * both VEHICLE_SELECTION and QUOTE_ISSUED) must never double-count.
 */
export async function upsertCustomerFromJourney(
  db: Executor,
  tenantId: TenantId,
  input: UpsertCustomerFromJourneyInput,
  now: Date,
): Promise<Customer> {
  const row = await db.customer.upsert({
    where: {
      tenantId_channel_customerRef: {
        tenantId,
        channel: input.channel,
        customerRef: input.customerRef,
      },
    },
    create: {
      tenantId,
      channel: input.channel,
      customerRef: input.customerRef,
      displayName: input.displayName,
      lastVehicleId: input.vehicleId,
      lastQuoteId: input.quoteId,
      bookingCount: input.bookingCompleted ? 1 : 0,
      lastJourneyId: input.journeyId,
      lastActivityAt: now,
    },
    update: {
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.vehicleId ? { lastVehicleId: input.vehicleId } : {}),
      ...(input.quoteId ? { lastQuoteId: input.quoteId } : {}),
      ...(input.bookingCompleted ? { bookingCount: { increment: 1 } } : {}),
      lastJourneyId: input.journeyId,
      lastActivityAt: now,
    },
  });
  return toDomainCustomer(row);
}

export async function findCustomerById(
  db: Executor,
  tenantId: TenantId,
  id: string,
): Promise<Customer | null> {
  const row = await db.customer.findFirst({ where: { id, tenantId } });
  return row ? toDomainCustomer(row) : null;
}

export interface ListCustomersParams {
  tenantId: TenantId;
  limit: number;
  offset: number;
}

export async function listCustomers(
  db: Executor,
  params: ListCustomersParams,
): Promise<Customer[]> {
  const rows = await db.customer.findMany({
    where: { tenantId: params.tenantId },
    orderBy: { lastActivityAt: 'desc' },
    take: params.limit,
    skip: params.offset,
  });
  return rows.map(toDomainCustomer);
}

export interface RecordCustomerTimelineEventParams {
  tenantId: TenantId;
  customerId: string;
  journeyId: string | null;
  type: CustomerTimelineEventTypeValue;
  summary: string;
}

export async function recordCustomerTimelineEvent(
  db: Executor,
  params: RecordCustomerTimelineEventParams,
): Promise<void> {
  await db.customerTimelineEvent.create({
    data: {
      tenantId: params.tenantId,
      customerId: params.customerId,
      journeyId: params.journeyId,
      type: params.type,
      summary: params.summary,
    },
  });
}

export async function findCustomerTimeline(db: Executor, tenantId: TenantId, customerId: string) {
  return db.customerTimelineEvent.findMany({
    where: { tenantId, customerId },
    orderBy: { createdAt: 'desc' },
  });
}
