import { z } from 'zod';
import { tenantIdSchema } from './tenant.js';
import { channelSchema } from './conversation.js';

/**
 * CRM — internal adapter (MASTER-PLAN.md §5 Phase 5: "CRM adapter (internal
 * default)"). One `Customer` row per (tenantId, channel, customerRef) —
 * the same identity key `Conversation`/`findOpenConversationForCustomer`
 * already use, so a customer's CRM profile and their conversation history
 * always resolve to the same row, never a separate reconciliation step.
 * Updated automatically as a journey progresses (see
 * apps/api/src/services/crmService.ts) — never hand-entered here, and
 * never a copy of another step's own persisted result (vehicle/quote stay
 * `id`-referenced, not duplicated).
 */
export const customerSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  channel: channelSchema,
  customerRef: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200).nullable(),
  lastVehicleId: z.string().uuid().nullable(),
  lastQuoteId: z.string().uuid().nullable(),
  bookingCount: z.number().int().nonnegative(),
  lastJourneyId: z.string().uuid().nullable(),
  lastActivityAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Customer = z.infer<typeof customerSchema>;

/**
 * One append-only CRM timeline entry per notable journey event — the
 * "timeline" MASTER-PLAN.md's admin dashboard contract (DESIGN-SYSTEM.md)
 * names for a customer record. `summary` is deterministic, template-built
 * from the triggering step's own already-validated output, exactly like
 * every other customer-facing/staff-facing generated text in this codebase
 * — never free-form AI text describing what happened.
 */
export const CustomerTimelineEventType = {
  JOURNEY_STARTED: 'JOURNEY_STARTED',
  VEHICLE_RESOLVED: 'VEHICLE_RESOLVED',
  QUOTE_ISSUED: 'QUOTE_ISSUED',
  ESCALATED: 'ESCALATED',
  ESCALATION_RESOLVED: 'ESCALATION_RESOLVED',
} as const;
export const customerTimelineEventTypeSchema = z.enum([
  CustomerTimelineEventType.JOURNEY_STARTED,
  CustomerTimelineEventType.VEHICLE_RESOLVED,
  CustomerTimelineEventType.QUOTE_ISSUED,
  CustomerTimelineEventType.ESCALATED,
  CustomerTimelineEventType.ESCALATION_RESOLVED,
]);
export type CustomerTimelineEventTypeValue = z.infer<typeof customerTimelineEventTypeSchema>;

export const customerTimelineEventSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  customerId: z.string().uuid(),
  journeyId: z.string().uuid().nullable(),
  type: customerTimelineEventTypeSchema,
  summary: z.string().min(1).max(300),
  createdAt: z.string().datetime(),
});
export type CustomerTimelineEvent = z.infer<typeof customerTimelineEventSchema>;

export const upsertCustomerFromJourneyInputSchema = z.object({
  channel: channelSchema,
  customerRef: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200).nullable(),
  journeyId: z.string().uuid(),
  vehicleId: z.string().uuid().nullable(),
  quoteId: z.string().uuid().nullable(),
  bookingCompleted: z.boolean(),
});
export type UpsertCustomerFromJourneyInput = z.infer<typeof upsertCustomerFromJourneyInputSchema>;
