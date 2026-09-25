import {
  findConversationById,
  recordCustomerTimelineEvent,
  upsertCustomerFromJourney,
  type PrismaClient,
} from '@ai-concierge/db';
import {
  AppError,
  type Customer,
  type CustomerTimelineEventTypeValue,
  type TenantId,
} from '@ai-concierge/domain';

export interface CrmServiceDeps {
  prisma: PrismaClient;
}

/**
 * CRM adapter (internal default) — MASTER-PLAN.md §5 Phase 5: "CRM adapter
 * (internal default)". The project brief's "CRM update automatically":
 * every call here is additive/best-effort, called from a route right after
 * the actual business operation (journey sync, quote issuance) already
 * succeeded — never a dependency the customer-facing response waits on or
 * can be broken by (see each call site's try/catch, same posture as
 * journeyService.ts's own calls).
 */

export interface SyncCustomerFromJourneyInput {
  tenantId: TenantId;
  conversationId: string;
  journeyId: string;
  eventType: CustomerTimelineEventTypeValue;
  eventSummary: string;
  vehicleId: string | null;
  quoteId: string | null;
  bookingCompleted: boolean;
}

export async function syncCustomerFromJourney(
  deps: CrmServiceDeps,
  input: SyncCustomerFromJourneyInput,
): Promise<Customer> {
  const conversation = await findConversationById(
    deps.prisma,
    input.tenantId,
    input.conversationId,
  );
  if (!conversation) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }

  return deps.prisma.$transaction(async (tx) => {
    const customer = await upsertCustomerFromJourney(
      tx,
      input.tenantId,
      {
        channel: conversation.channel,
        customerRef: conversation.customerRef,
        displayName: null, // Steps 1-4 never extract a customer's name from free text — left to a future step/dashboard edit, never guessed.
        journeyId: input.journeyId,
        vehicleId: input.vehicleId,
        quoteId: input.quoteId,
        bookingCompleted: input.bookingCompleted,
      },
      new Date(),
    );

    await recordCustomerTimelineEvent(tx, {
      tenantId: input.tenantId,
      customerId: customer.id,
      journeyId: input.journeyId,
      type: input.eventType,
      summary: input.eventSummary,
    });

    return customer;
  });
}
