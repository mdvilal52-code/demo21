import { z } from 'zod';
import { tenantIdSchema } from './tenant.js';

/**
 * The Event/Workflow Engine — MASTER-PLAN.md §1's centerpiece, undelivered
 * until this phase. `JourneyState` is MASTER-PLAN.md §4's state column,
 * verbatim. A `Journey` row is the one persisted, resumable source of truth
 * for where a conversation stands in the 19-step rental journey. Steps 1-8
 * (packages/ai) are unchanged — pure, zero I/O, AI-proposes/domain-verifies
 * — this layer is what actually calls them in sequence, persists the
 * result, and decides whether to escalate, instead of the old hardcoded
 * `runFullEnquiryPipeline` 1-4-only chain (still present for backward
 * compatibility; superseded going forward — see
 * apps/api/src/services/journeyService.ts).
 *
 * Steps 9-19's states are modeled here now (so the state machine is
 * correct and complete against MASTER-PLAN.md §4 from day one) even though
 * the services that drive transitions into/out of them (documents,
 * payments, CRM, delivery, …) are a later phase — `advanceJourney` only
 * drives as far as real step services exist today (through QUOTE_ISSUED)
 * and leaves the journey at a well-defined waiting state otherwise, never
 * a fabricated transition.
 */
export const JourneyState = {
  ENQUIRY_RECEIVED: 'ENQUIRY_RECEIVED',
  EXTRACTING_REQUIREMENTS: 'EXTRACTING_REQUIREMENTS',
  VEHICLE_SELECTION: 'VEHICLE_SELECTION',
  COLLECTING_MISSING_INFO: 'COLLECTING_MISSING_INFO',
  ELIGIBILITY_CHECK: 'ELIGIBILITY_CHECK',
  AVAILABILITY_CHECK: 'AVAILABILITY_CHECK',
  OFFERING_ALTERNATIVES: 'OFFERING_ALTERNATIVES',
  QUOTE_ISSUED: 'QUOTE_ISSUED',
  DOCUMENTS_REQUESTED: 'DOCUMENTS_REQUESTED',
  DOCUMENTS_VERIFYING: 'DOCUMENTS_VERIFYING',
  PAYMENT_INSTRUCTED: 'PAYMENT_INSTRUCTED',
  CRM_UPDATED: 'CRM_UPDATED',
  AWAITING_HUMAN_APPROVAL: 'AWAITING_HUMAN_APPROVAL',
  CONFIRMED: 'CONFIRMED',
  DELIVERY_SCHEDULED: 'DELIVERY_SCHEDULED',
  ON_RENTAL: 'ON_RENTAL',
  RETURN_SCHEDULED: 'RETURN_SCHEDULED',
  RETURNED: 'RETURNED',
  FINAL_INVOICE_ISSUED: 'FINAL_INVOICE_ISSUED',
  FOLLOW_UP_SENT: 'FOLLOW_UP_SENT',
  CLOSED: 'CLOSED',
  // Overlay states — MASTER-PLAN.md §4 footer: "resumable" / terminal, reachable from most states.
  ESCALATED: 'ESCALATED',
  CANCELLED: 'CANCELLED',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
} as const;

export const journeyStateSchema = z.enum([
  JourneyState.ENQUIRY_RECEIVED,
  JourneyState.EXTRACTING_REQUIREMENTS,
  JourneyState.VEHICLE_SELECTION,
  JourneyState.COLLECTING_MISSING_INFO,
  JourneyState.ELIGIBILITY_CHECK,
  JourneyState.AVAILABILITY_CHECK,
  JourneyState.OFFERING_ALTERNATIVES,
  JourneyState.QUOTE_ISSUED,
  JourneyState.DOCUMENTS_REQUESTED,
  JourneyState.DOCUMENTS_VERIFYING,
  JourneyState.PAYMENT_INSTRUCTED,
  JourneyState.CRM_UPDATED,
  JourneyState.AWAITING_HUMAN_APPROVAL,
  JourneyState.CONFIRMED,
  JourneyState.DELIVERY_SCHEDULED,
  JourneyState.ON_RENTAL,
  JourneyState.RETURN_SCHEDULED,
  JourneyState.RETURNED,
  JourneyState.FINAL_INVOICE_ISSUED,
  JourneyState.FOLLOW_UP_SENT,
  JourneyState.CLOSED,
  JourneyState.ESCALATED,
  JourneyState.CANCELLED,
  JourneyState.DECLINED,
  JourneyState.EXPIRED,
]);
export type JourneyStateValue = z.infer<typeof journeyStateSchema>;

/** Terminal states — a journey here never transitions again (a new customer message starts a new journey). */
export const TERMINAL_JOURNEY_STATES: readonly JourneyStateValue[] = [
  JourneyState.CLOSED,
  JourneyState.CANCELLED,
  JourneyState.DECLINED,
  JourneyState.EXPIRED,
];

/**
 * MASTER-PLAN.md §4's "Owner" column, condensed to who drove the most
 * recent transition — never a permission check by itself (that is
 * `@ai-concierge/security`'s job); purely descriptive, surfaced on the
 * admin journey timeline.
 */
export const JourneyActor = {
  AI: 'AI',
  SYSTEM: 'SYSTEM',
  HUMAN: 'HUMAN',
} as const;
export const journeyActorSchema = z.enum([
  JourneyActor.AI,
  JourneyActor.SYSTEM,
  JourneyActor.HUMAN,
]);
export type JourneyActorValue = z.infer<typeof journeyActorSchema>;

/**
 * The one, closed, Zod-validated shape of a journey's working state —
 * deliberately narrow: every field here is an id pointing back at a step's
 * own already-persisted, already-validated row (IntentRecord, Vehicle,
 * Quote, …), never a duplicate copy of that row's data. `attempts` counts
 * COLLECTING_MISSING_INFO re-checks per conversation, the input
 * `decideEscalation` (packages/workflow) uses to escalate a customer who
 * never completes their booking info instead of waiting forever.
 */
export const journeyContextSchema = z.object({
  conversationId: z.string().uuid(),
  latestMessageId: z.string().uuid().nullable(),
  resolvedVehicleId: z.string().uuid().nullable(),
  quoteId: z.string().uuid().nullable(),
  missingInfoAttempts: z.number().int().nonnegative(),
});
export type JourneyContext = z.infer<typeof journeyContextSchema>;

export function createInitialJourneyContext(conversationId: string): JourneyContext {
  return {
    conversationId,
    latestMessageId: null,
    resolvedVehicleId: null,
    quoteId: null,
    missingInfoAttempts: 0,
  };
}

export const journeySchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  conversationId: z.string().uuid(),
  state: journeyStateSchema,
  context: journeyContextSchema,
  version: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Journey = z.infer<typeof journeySchema>;

export const journeyTransitionSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  journeyId: z.string().uuid(),
  fromState: journeyStateSchema.nullable(),
  toState: journeyStateSchema,
  actor: journeyActorSchema,
  reason: z.string().min(1).max(300),
  createdAt: z.string().datetime(),
});
export type JourneyTransition = z.infer<typeof journeyTransitionSchema>;

// ---------------------------------------------------------------------
// Human escalation — MASTER-PLAN.md §4: "T1 AI · T2 Ops agent · T3
// Manager · T4 Security/Compliance". T1 is the AI itself, never a
// persisted case; an EscalationCase always names a human tier.
// ---------------------------------------------------------------------

export const EscalationTier = {
  T2: 'T2',
  T3: 'T3',
  T4: 'T4',
} as const;
export const escalationTierSchema = z.enum([
  EscalationTier.T2,
  EscalationTier.T3,
  EscalationTier.T4,
]);
export type EscalationTierValue = z.infer<typeof escalationTierSchema>;

/**
 * Matches DESIGN-SYSTEM.md/the automation-map reference's own "High-Stakes
 * Steps (Always Human)" panel: large discounts, identity/fraud, driver
 * eligibility exceptions, payment exceptions, damage claims, VIP service,
 * complaints/escalations all map to one of these reasons.
 */
export const EscalationReason = {
  ELIGIBILITY_NEEDS_REVIEW: 'ELIGIBILITY_NEEDS_REVIEW',
  AVAILABILITY_PROVIDER_FAILURE: 'AVAILABILITY_PROVIDER_FAILURE',
  QUOTE_NEEDS_REVIEW: 'QUOTE_NEEDS_REVIEW',
  DOCUMENT_REJECTED_REPEATEDLY: 'DOCUMENT_REJECTED_REPEATEDLY',
  PAYMENT_EXCEPTION: 'PAYMENT_EXCEPTION',
  DAMAGE_OR_DISPUTE: 'DAMAGE_OR_DISPUTE',
  CUSTOMER_COMPLAINT: 'CUSTOMER_COMPLAINT',
  MISSING_INFO_STALLED: 'MISSING_INFO_STALLED',
  AI_UNABLE_TO_PROCEED: 'AI_UNABLE_TO_PROCEED',
} as const;
export const escalationReasonSchema = z.enum([
  EscalationReason.ELIGIBILITY_NEEDS_REVIEW,
  EscalationReason.AVAILABILITY_PROVIDER_FAILURE,
  EscalationReason.QUOTE_NEEDS_REVIEW,
  EscalationReason.DOCUMENT_REJECTED_REPEATEDLY,
  EscalationReason.PAYMENT_EXCEPTION,
  EscalationReason.DAMAGE_OR_DISPUTE,
  EscalationReason.CUSTOMER_COMPLAINT,
  EscalationReason.MISSING_INFO_STALLED,
  EscalationReason.AI_UNABLE_TO_PROCEED,
]);
export type EscalationReasonValue = z.infer<typeof escalationReasonSchema>;

export const EscalationStatus = {
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  CANCELLED: 'CANCELLED',
} as const;
export const escalationStatusSchema = z.enum([
  EscalationStatus.OPEN,
  EscalationStatus.IN_PROGRESS,
  EscalationStatus.RESOLVED,
  EscalationStatus.CANCELLED,
]);
export type EscalationStatusValue = z.infer<typeof escalationStatusSchema>;

/** The human decision that resolves a case — always one of these, never free-form AI text driving the journey. */
export const EscalationResolution = {
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export const escalationResolutionSchema = z.enum([
  EscalationResolution.APPROVED,
  EscalationResolution.REJECTED,
]);
export type EscalationResolutionValue = z.infer<typeof escalationResolutionSchema>;

/**
 * SLA windows per tier (MASTER-PLAN.md §4: "SLA timer"). Deliberately a
 * fixed, documented policy rather than tenant-configurable yet — the same
 * "narrow, honest scope over a fake knob" choice every earlier phase made
 * (e.g. Step 5's policy is tenant-configurable because MASTER-PLAN.md names
 * it as such; nothing here does for escalation SLAs).
 */
export const ESCALATION_SLA_MINUTES: Record<EscalationTierValue, number> = {
  T2: 60,
  T3: 240,
  T4: 30,
};

export const escalationCaseSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  journeyId: z.string().uuid(),
  tier: escalationTierSchema,
  reason: escalationReasonSchema,
  status: escalationStatusSchema,
  detail: z.string().min(1).max(1000),
  assignedToUserId: z.string().uuid().nullable(),
  slaDueAt: z.string().datetime(),
  slaBreached: z.boolean(),
  resolution: escalationResolutionSchema.nullable(),
  resolutionNote: z.string().max(1000).nullable(),
  resolvedByUserId: z.string().uuid().nullable(),
  resolvedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EscalationCase = z.infer<typeof escalationCaseSchema>;

export const createEscalationCaseInputSchema = z.object({
  journeyId: z.string().uuid(),
  tier: escalationTierSchema,
  reason: escalationReasonSchema,
  detail: z.string().min(1).max(1000),
});
export type CreateEscalationCaseInput = z.infer<typeof createEscalationCaseInputSchema>;

export const resolveEscalationCaseInputSchema = z.object({
  resolution: escalationResolutionSchema,
  resolutionNote: z.string().min(1).max(1000),
});
export type ResolveEscalationCaseInput = z.infer<typeof resolveEscalationCaseInputSchema>;
