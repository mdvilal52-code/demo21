import {
  acquireJourneyLock,
  createEscalationCase,
  createJourney,
  findActiveUsersByRole,
  findJourneyByConversationId,
  findJourneyTransitions,
  PrismaAuditWriter,
  transitionJourney,
  type PrismaClient,
} from '@ai-concierge/db';
import {
  createInitialJourneyContext,
  AppError,
  EligibilityDecisionStatus,
  InventoryStatus,
  JourneyState,
  MissingInfoStatus,
  UserRole,
  type EligibilityDecisionStatusValue,
  type InventoryStatusValue,
  type Journey,
  type JourneyContext,
  type JourneyStateValue,
  type JourneyTransition,
  type MissingInfoStatusValue,
  type QuoteStatusValue,
  type TenantId,
  type UserRoleValue,
} from '@ai-concierge/domain';
import {
  checkTransition,
  decideAvailabilityEscalation,
  decideEligibilityEscalation,
  decideMissingInfoEscalation,
  decideQuoteEscalation,
  isTerminalState,
  type EscalationDecision,
} from '@ai-concierge/workflow';
import type { NotificationProvider } from '../lib/notificationProvider.js';

export interface JourneyServiceDeps {
  prisma: PrismaClient;
  notificationProvider: NotificationProvider;
}

/**
 * The Event/Workflow Engine's application layer — MASTER-PLAN.md §1's
 * Event/Workflow Engine box, finally wired up. Every function here is
 * additive to an already-tested step service, never a replacement: Steps
 * 1-8's own services (enquiryService, dateLocationService, vehicleService,
 * missingInfoService, eligibilityService, availabilityService,
 * alternativesService, quoteService) keep deciding and persisting their own
 * results exactly as before. This layer only tracks *where the customer's
 * journey stands* on top of that, and decides whether a human needs to be
 * pulled in (`@ai-concierge/workflow`'s escalationPolicy) — never the other
 * way around. A journey-sync failure never fails the calling request; see
 * each route's try/catch around these calls.
 */

const TIER_TO_ROLE: Record<EscalationDecision['tier'], UserRoleValue> = {
  T2: UserRole.OPS_AGENT,
  T3: UserRole.MANAGER,
  T4: UserRole.SECURITY,
};

async function pageTier(
  deps: JourneyServiceDeps,
  tenantId: TenantId,
  tier: EscalationDecision['tier'],
  escalationCaseId: string,
  reason: string,
): Promise<void> {
  const staff = await findActiveUsersByRole(deps.prisma, tenantId, TIER_TO_ROLE[tier]);
  const body = `AI Concierge: a customer needs you — ${reason.toLowerCase()}. Case ${escalationCaseId} is in your Escalation Queue.`;
  await Promise.all(
    staff
      .filter((user): user is typeof user & { phone: string } => Boolean(user.phone))
      .map((user) => deps.notificationProvider.sendSms(user.phone, body)),
  );
}

interface JourneyOutcome {
  journey: Journey;
  escalationCaseId: string | null;
  escalationTier: EscalationDecision['tier'] | null;
}

/**
 * Transitions `journey` straight to ESCALATED and creates the case, inside
 * the caller's own transaction. Returns `null` (a silent no-op, not an
 * error) if the journey is already terminal/escalated — an escalation
 * decision arriving for a journey a human is already handling, or that
 * already ended, is not a bug, just stale.
 */
async function escalate(
  tx: Parameters<typeof transitionJourney>[0],
  tenantId: TenantId,
  journey: Journey,
  decision: EscalationDecision,
  requestId: string,
): Promise<JourneyOutcome | null> {
  const check = checkTransition({
    from: journey.state,
    to: JourneyState.ESCALATED,
    reason: decision.reason,
  });
  if (!check.allowed) return null;

  const result = await transitionJourney(tx, {
    tenantId,
    journeyId: journey.id,
    expectedVersion: journey.version,
    toState: JourneyState.ESCALATED,
    context: journey.context,
    actor: 'SYSTEM',
    reason: `${decision.tier} escalation: ${decision.detail}`,
  });
  if (result.outcome !== 'TRANSITIONED') return null;

  const escalationCase = await createEscalationCase(
    tx,
    tenantId,
    {
      journeyId: journey.id,
      tier: decision.tier,
      reason: decision.reason,
      detail: decision.detail,
    },
    new Date(),
  );

  await new PrismaAuditWriter(tx).record({
    tenantId,
    actor: 'system:journey-service',
    action: 'journey.escalated',
    entityType: 'Journey',
    entityId: journey.id,
    after: { tier: decision.tier, reason: decision.reason, escalationCaseId: escalationCase.id },
    requestId,
  });

  return {
    journey: result.journey,
    escalationCaseId: escalationCase.id,
    escalationTier: decision.tier,
  };
}

/** Applies a plain state transition (no escalation) inside the caller's transaction; `null` if illegal or lost the version race. */
async function advance(
  tx: Parameters<typeof transitionJourney>[0],
  tenantId: TenantId,
  journey: Journey,
  toState: JourneyStateValue,
  context: JourneyContext,
  reason: string,
): Promise<Journey | null> {
  const check = checkTransition({ from: journey.state, to: toState, reason });
  if (!check.allowed) return null;
  const result = await transitionJourney(tx, {
    tenantId,
    journeyId: journey.id,
    expectedVersion: journey.version,
    toState,
    context,
    actor: 'SYSTEM',
    reason,
  });
  return result.outcome === 'TRANSITIONED' ? result.journey : null;
}

async function notifyIfEscalated(
  deps: JourneyServiceDeps,
  tenantId: TenantId,
  outcome: JourneyOutcome | null,
) {
  if (outcome?.escalationCaseId && outcome.escalationTier) {
    await pageTier(
      deps,
      tenantId,
      outcome.escalationTier,
      outcome.escalationCaseId,
      outcome.journey.state,
    );
  }
}

export interface SyncJourneyAfterMissingInfoInput {
  tenantId: TenantId;
  conversationId: string;
  messageId: string;
  resolvedVehicleId: string | null;
  missingInfoStatus: MissingInfoStatusValue;
  requestId: string;
}

/**
 * Called once, at the end of the existing Steps 1-4 pipeline
 * (enquiryPipelineService.ts), after `checkMissingInfo` has already run and
 * persisted its own result. Fast-forwards a freshly created journey through
 * ENQUIRY_RECEIVED -> EXTRACTING_REQUIREMENTS -> VEHICLE_SELECTION ->
 * COLLECTING_MISSING_INFO (Steps 1-3 always ran together to get here, so
 * these three hops are not independently decided), then applies Step 4's
 * own status. A journey already ESCALATED or terminal is left untouched —
 * once a human is pulled in, the AI pipeline stops nudging that journey
 * until the human resolves the case (see escalationService.ts).
 */
export async function syncJourneyAfterMissingInfo(
  deps: JourneyServiceDeps,
  input: SyncJourneyAfterMissingInfoInput,
): Promise<Journey> {
  const outcome = await deps.prisma.$transaction(async (tx) => {
    await acquireJourneyLock(tx, input.tenantId, input.conversationId);
    let journey = await findJourneyByConversationId(tx, input.tenantId, input.conversationId);
    if (!journey) {
      journey = await createJourney(tx, {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        context: createInitialJourneyContext(input.conversationId),
      });
    }

    if (isTerminalState(journey.state) || journey.state === JourneyState.ESCALATED) {
      return { journey, escalationCaseId: null, escalationTier: null } satisfies JourneyOutcome;
    }

    if (journey.state === JourneyState.ENQUIRY_RECEIVED) {
      for (const [toState, reason] of [
        [JourneyState.EXTRACTING_REQUIREMENTS, 'intent recognized'],
        [JourneyState.VEHICLE_SELECTION, 'dates/location extracted'],
        [JourneyState.COLLECTING_MISSING_INFO, 'vehicle determined'],
      ] as const) {
        const next = await advance(tx, input.tenantId, journey, toState, journey.context, reason);
        if (!next)
          throw new Error(`journeyService: unexpected fixed-sequence hop failure at ${toState}`);
        journey = next;
      }
    }

    const context: JourneyContext = {
      ...journey.context,
      latestMessageId: input.messageId,
      resolvedVehicleId: input.resolvedVehicleId ?? journey.context.resolvedVehicleId,
    };

    if (input.missingInfoStatus === MissingInfoStatus.NOT_APPLICABLE) {
      // Not a booking conversation (yet) — leave the journey exactly where it is.
      return { journey, escalationCaseId: null, escalationTier: null } satisfies JourneyOutcome;
    }

    if (input.missingInfoStatus === MissingInfoStatus.NEEDS_INFO) {
      context.missingInfoAttempts += 1;
      const decision = decideMissingInfoEscalation(
        input.missingInfoStatus,
        context.missingInfoAttempts,
      );
      if (decision) {
        const escalated = await escalate(tx, input.tenantId, journey, decision, input.requestId);
        if (escalated) return escalated;
      }
      const next = await advance(
        tx,
        input.tenantId,
        journey,
        JourneyState.COLLECTING_MISSING_INFO,
        context,
        `still missing info (attempt ${context.missingInfoAttempts})`,
      );
      return {
        journey: next ?? journey,
        escalationCaseId: null,
        escalationTier: null,
      } satisfies JourneyOutcome;
    }

    const toState =
      input.missingInfoStatus === MissingInfoStatus.COMPLETE
        ? JourneyState.ELIGIBILITY_CHECK
        : input.missingInfoStatus === MissingInfoStatus.EXPIRED
          ? JourneyState.EXPIRED
          : JourneyState.CANCELLED;
    if (toState === JourneyState.ELIGIBILITY_CHECK) context.missingInfoAttempts = 0;
    const next = await advance(
      tx,
      input.tenantId,
      journey,
      toState,
      context,
      `Step 4: ${input.missingInfoStatus}`,
    );
    return {
      journey: next ?? journey,
      escalationCaseId: null,
      escalationTier: null,
    } satisfies JourneyOutcome;
  });

  await notifyIfEscalated(deps, input.tenantId, outcome);
  return outcome.journey;
}

export interface RecordEligibilityOutcomeInput {
  tenantId: TenantId;
  conversationId: string;
  status: EligibilityDecisionStatusValue;
  reason: string;
  requestId: string;
}

/**
 * Called by eligibilityService.ts right after it persists its own
 * `EligibilityDecision` (a separate transaction — see the module doc).
 * Best-effort: if no journey exists yet, or it is not currently waiting at
 * ELIGIBILITY_CHECK, this is a silent no-op — the eligibility decision
 * itself is already correctly persisted and returned regardless.
 */
export async function recordEligibilityOutcome(
  deps: JourneyServiceDeps,
  input: RecordEligibilityOutcomeInput,
): Promise<void> {
  const outcome = await deps.prisma.$transaction(async (tx) => {
    await acquireJourneyLock(tx, input.tenantId, input.conversationId);
    const journey = await findJourneyByConversationId(tx, input.tenantId, input.conversationId);
    if (!journey || journey.state !== JourneyState.ELIGIBILITY_CHECK) return null;

    const decision = decideEligibilityEscalation(input.status, input.reason);
    if (decision) return escalate(tx, input.tenantId, journey, decision, input.requestId);

    const toState =
      input.status === EligibilityDecisionStatus.ELIGIBLE
        ? JourneyState.AVAILABILITY_CHECK
        : JourneyState.DECLINED;
    const next = await advance(
      tx,
      input.tenantId,
      journey,
      toState,
      journey.context,
      `Eligibility: ${input.status}`,
    );
    return next
      ? ({ journey: next, escalationCaseId: null, escalationTier: null } satisfies JourneyOutcome)
      : null;
  });

  await notifyIfEscalated(deps, input.tenantId, outcome);
}

export interface RecordAvailabilityOutcomeInput {
  tenantId: TenantId;
  conversationId: string;
  status: InventoryStatusValue;
  retryable: boolean;
  reason: string | null;
  requestId: string;
}

/**
 * Called by availabilityService.ts after `ReservationLockService` resolves.
 * Accepts the journey at either AVAILABILITY_CHECK (a first check) or
 * OFFERING_ALTERNATIVES (re-checking a newly chosen alternative) — hops
 * back to AVAILABILITY_CHECK first in the latter case, then applies the
 * same outcome logic. AVAILABLE/HELD leaves the journey *at*
 * AVAILABILITY_CHECK — that state doubles as "ready for a quote request",
 * the same "reaching state X means X's precondition is satisfied" reading
 * ELIGIBILITY_CHECK itself already uses.
 */
export async function recordAvailabilityOutcome(
  deps: JourneyServiceDeps,
  input: RecordAvailabilityOutcomeInput,
): Promise<void> {
  const outcome = await deps.prisma.$transaction(async (tx) => {
    await acquireJourneyLock(tx, input.tenantId, input.conversationId);
    let journey = await findJourneyByConversationId(tx, input.tenantId, input.conversationId);
    if (!journey) return null;
    if (journey.state === JourneyState.OFFERING_ALTERNATIVES) {
      const next = await advance(
        tx,
        input.tenantId,
        journey,
        JourneyState.AVAILABILITY_CHECK,
        journey.context,
        'rechecking availability for a newly chosen alternative',
      );
      if (!next) return null;
      journey = next;
    }
    if (journey.state !== JourneyState.AVAILABILITY_CHECK) return null;

    const decision = decideAvailabilityEscalation(input.status, input.retryable, input.reason);
    if (decision) return escalate(tx, input.tenantId, journey, decision, input.requestId);

    if (
      input.status === InventoryStatus.UNAVAILABLE ||
      input.status === InventoryStatus.MAINTENANCE
    ) {
      const next = await advance(
        tx,
        input.tenantId,
        journey,
        JourneyState.OFFERING_ALTERNATIVES,
        journey.context,
        `Availability: ${input.status}`,
      );
      return next
        ? ({ journey: next, escalationCaseId: null, escalationTier: null } satisfies JourneyOutcome)
        : null;
    }
    // AVAILABLE/HELD/non-retryable-UNKNOWN: no transition — already at the right resting state.
    return null;
  });

  await notifyIfEscalated(deps, input.tenantId, outcome);
}

export interface RecordQuoteOutcomeInput {
  tenantId: TenantId;
  conversationId: string;
  status: QuoteStatusValue;
  reviewReasons: readonly string[];
  requestId: string;
}

/** Called by quoteService.ts after `createQuote` persists its own `Quote` row. */
export async function recordQuoteOutcome(
  deps: JourneyServiceDeps,
  input: RecordQuoteOutcomeInput,
): Promise<void> {
  const outcome = await deps.prisma.$transaction(async (tx) => {
    await acquireJourneyLock(tx, input.tenantId, input.conversationId);
    const journey = await findJourneyByConversationId(tx, input.tenantId, input.conversationId);
    if (!journey || journey.state !== JourneyState.AVAILABILITY_CHECK) return null;

    const decision = decideQuoteEscalation(input.status, input.reviewReasons);
    if (decision) return escalate(tx, input.tenantId, journey, decision, input.requestId);

    const next = await advance(
      tx,
      input.tenantId,
      journey,
      JourneyState.QUOTE_ISSUED,
      journey.context,
      `Quote: ${input.status}`,
    );
    return next
      ? ({ journey: next, escalationCaseId: null, escalationTier: null } satisfies JourneyOutcome)
      : null;
  });

  await notifyIfEscalated(deps, input.tenantId, outcome);
}

export interface RecordAlternativesOutcomeInput {
  tenantId: TenantId;
  conversationId: string;
}

/** Called by alternativesService.ts — never escalates (MASTER-PLAN.md: "AI may explain, never decide"), just tracks the hand-off to the customer. */
export async function recordAlternativesOutcome(
  deps: JourneyServiceDeps,
  input: RecordAlternativesOutcomeInput,
): Promise<void> {
  await deps.prisma.$transaction(async (tx) => {
    await acquireJourneyLock(tx, input.tenantId, input.conversationId);
    const journey = await findJourneyByConversationId(tx, input.tenantId, input.conversationId);
    if (!journey || journey.state !== JourneyState.AVAILABILITY_CHECK) return;
    await advance(
      tx,
      input.tenantId,
      journey,
      JourneyState.OFFERING_ALTERNATIVES,
      journey.context,
      'alternatives presented',
    );
  });
}

export interface GetJourneyInput {
  tenantId: TenantId;
  conversationId: string;
}

export interface GetJourneyResult {
  journey: Journey;
  transitions: JourneyTransition[];
}

/** The admin dashboard's read surface for one conversation's journey — current state plus its full, append-only timeline. */
export async function getJourney(
  deps: JourneyServiceDeps,
  input: GetJourneyInput,
): Promise<GetJourneyResult> {
  const journey = await findJourneyByConversationId(
    deps.prisma,
    input.tenantId,
    input.conversationId,
  );
  if (!journey) {
    throw new AppError('NOT_FOUND', 'No journey exists for this conversation');
  }
  const transitions = await findJourneyTransitions(deps.prisma, input.tenantId, journey.id);
  return { journey, transitions };
}

export interface EscalateJourneyInput {
  tenantId: TenantId;
  conversationId: string;
  decision: EscalationDecision;
  requestId: string;
}

export interface EscalateJourneyResult {
  escalated: boolean;
  escalationCaseId: string | null;
  tier: EscalationDecision['tier'] | null;
}

/**
 * Hands a live journey to a human on the concierge's own initiative — the
 * customer asked for a person, or accepted a quote and the steps after it
 * (documents, payment, confirmation) are still manual. Uses exactly the same
 * path as every policy-driven escalation above (journey -> ESCALATED, an
 * EscalationCase, an audit event, and an SMS page to the on-call tier), so
 * the case appears on the dashboard's Escalation Queue like any other.
 *
 * A journey that is already ESCALATED, terminal, or missing is a silent
 * no-op (`escalated: false`), never an error: two overlapping decisions for
 * the same customer must not create two cases.
 */
export async function escalateJourney(
  deps: JourneyServiceDeps,
  input: EscalateJourneyInput,
): Promise<EscalateJourneyResult> {
  const outcome = await deps.prisma.$transaction(async (tx) => {
    await acquireJourneyLock(tx, input.tenantId, input.conversationId);
    const journey = await findJourneyByConversationId(tx, input.tenantId, input.conversationId);
    if (!journey) return null;
    return escalate(tx, input.tenantId, journey, input.decision, input.requestId);
  });

  await notifyIfEscalated(deps, input.tenantId, outcome);
  return {
    escalated: outcome !== null,
    escalationCaseId: outcome?.escalationCaseId ?? null,
    tier: outcome?.escalationTier ?? null,
  };
}
