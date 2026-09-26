import type {
  AIProvider,
  AlternativeRecommendationOrchestrator,
  EligibilityOrchestrator,
  PricingRules,
  QuoteValidator,
} from '@ai-concierge/ai';
import {
  findJourneyByConversationId,
  findLatestAlternativeRecommendationForConversation,
  findOutboundMessagesForConversation,
  type PrismaClient,
} from '@ai-concierge/db';
import {
  CustomerTimelineEventType,
  EligibilityDecisionStatus,
  EscalationReason,
  EscalationTier,
  InventoryStatus,
  JourneyState,
  QuoteErrorCode,
  QuoteStatus,
  isAppError,
  quoteSelectionsSchema,
  type CollectedBookingInfo,
  type CustomerTimelineEventTypeValue,
  type Journey,
  type MissingInfoStatusValue,
  type TenantId,
} from '@ai-concierge/domain';
import { isTerminalState, type EscalationDecision } from '@ai-concierge/workflow';
import type { NotificationProvider } from '../lib/notificationProvider.js';
import { checkAvailability } from './availabilityService.js';
import { recommendAlternatives } from './alternativesService.js';
import { checkEligibility } from './eligibilityService.js';
import { collectEligibilityIntake, markIntakeRequested } from './eligibilityIntakeService.js';
import type { ReplyServiceLogger } from './conversationalReplyService.js';
import { syncCustomerFromJourney } from './crmService.js';
import {
  escalateJourney,
  isStalledInfoEscalation,
  resumeStalledJourney,
  recordAlternativesOutcome,
  recordAvailabilityOutcome,
  recordEligibilityOutcome,
  recordQuoteOutcome,
} from './journeyService.js';
import type { HumanReviewCause, JourneyProgress } from './journeyProgress.js';
import { createQuote, getQuote } from './quoteService.js';
import type { ReservationLockService } from './reservationLockService.js';

export interface JourneyAutopilotDeps {
  prisma: PrismaClient;
  notificationProvider: NotificationProvider;
  aiProvider: AIProvider;
  logger: ReplyServiceLogger;
  eligibilityOrchestrator: EligibilityOrchestrator;
  reservationLockService: ReservationLockService;
  alternativeRecommendationOrchestrator: AlternativeRecommendationOrchestrator;
  pricingRules: PricingRules;
  quoteValidator: QuoteValidator;
  /** `config.WEBHOOK_SIGNING_SECRET` — the quote integrity-hash secret (see quoteService). */
  integritySecret: string;
  piiKey: string;
}

export interface AdvanceJourneyInput {
  tenantId: TenantId;
  conversationId: string;
  requestId: string;
  /** The journey *after* `syncJourneyAfterMissingInfo` ran for this message. */
  journey: Journey;
  /** Step 4's verdict for this message (drives how a stalled-info escalation is handled). */
  missingInfoStatus: MissingInfoStatusValue;
  /** What Steps 2-4 have resolved for the conversation so far. */
  collected: CollectedBookingInfo;
  /** The customer's message being answered. */
  customerMessage: string;
  /** Step 1's classification of that message (`COMPLAINT` triggers a human hand-off). */
  intentType: string;
}

/** After this many unanswered requests for driver details, stop asking and hand the customer to a person. */
export const ELIGIBILITY_ASK_LIMIT = 4;

const HUMAN_REQUEST_PATTERN = new RegExp(
  [
    String.raw`\b(?:speak|talk|chat|connect|transfer|escalate|put me through)\b.{0,30}\b(?:human|person|agent|representative|manager|someone|somebody|staff|team|colleague|supervisor)\b`,
    String.raw`\b(?:real|live|actual)\s+(?:person|human|agent|people)\b`,
    String.raw`\bhuman\s+(?:agent|being|help|support)\b`,
    String.raw`\bcustomer\s+(?:service|care|support)\b`,
    String.raw`\b(?:call|phone)\s+me\b`,
    String.raw`\b(?:insaan|aadmi|banda|manager)\s+se\b`,
  ].join('|'),
  'i',
);

const QUOTE_ACCEPTANCE_PATTERN = new RegExp(
  [
    String.raw`\bi(?:'|’)?ll take it\b`,
    String.raw`\bi will take it\b`,
    String.raw`\b(?:i )?accept\b`,
    String.raw`\bgo ahead\b`,
    String.raw`\bproceed\b`,
    String.raw`\blet(?:'|’)?s (?:do it|go|proceed|book)\b`,
    String.raw`\bbook it\b`,
    String.raw`\bconfirm(?:ed)?\b`,
    String.raw`\bsounds good\b`,
    String.raw`\bthat works\b`,
    String.raw`\bdeal\b`,
    String.raw`\bbook kar do\b`,
    String.raw`\bkar do\b`,
    String.raw`\btheek hai\b`,
    String.raw`\bhaan\b`,
  ].join('|'),
  'i',
);

/** Acceptance is a short reply ("yes, book it"); a long message asking a question is not one. */
const MAX_WORDS_FOR_ACCEPTANCE = 14;

export function wantsHuman(text: string): boolean {
  return HUMAN_REQUEST_PATTERN.test(text);
}

export function acceptsQuote(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words <= MAX_WORDS_FOR_ACCEPTANCE && QUOTE_ACCEPTANCE_PATTERN.test(text);
}

interface Ctx {
  deps: JourneyAutopilotDeps;
  input: AdvanceJourneyInput;
  journey: Journey;
}

function journeyDeps(deps: JourneyAutopilotDeps) {
  return { prisma: deps.prisma, notificationProvider: deps.notificationProvider };
}

async function reloadJourney(ctx: Ctx): Promise<Journey> {
  const fresh = await findJourneyByConversationId(
    ctx.deps.prisma,
    ctx.input.tenantId,
    ctx.input.conversationId,
  );
  return fresh ?? ctx.journey;
}

async function recordCrmEvent(
  ctx: Ctx,
  eventType: CustomerTimelineEventTypeValue,
  eventSummary: string,
  quoteId: string | null,
): Promise<void> {
  try {
    await syncCustomerFromJourney(
      { prisma: ctx.deps.prisma },
      {
        tenantId: ctx.input.tenantId,
        conversationId: ctx.input.conversationId,
        journeyId: ctx.journey.id,
        eventType,
        eventSummary,
        vehicleId: ctx.input.collected.vehicle?.id ?? null,
        quoteId,
        bookingCompleted: false,
      },
    );
  } catch (error) {
    ctx.deps.logger.error({ err: error }, 'autopilot: CRM sync failed');
  }
}

/**
 * Hands the journey to a person and describes the outcome. Never throws: the
 * customer must always get a truthful reply, and `handoffRecorded: false`
 * tells the reply layer not to claim someone was notified when the case could
 * not actually be created.
 */
async function handOff(
  ctx: Ctx,
  cause: HumanReviewCause,
  decision: EscalationDecision,
): Promise<JourneyProgress> {
  try {
    const result = await escalateJourney(journeyDeps(ctx.deps), {
      tenantId: ctx.input.tenantId,
      conversationId: ctx.input.conversationId,
      decision,
      requestId: ctx.input.requestId,
    });
    if (result.escalated) {
      await recordCrmEvent(
        ctx,
        CustomerTimelineEventType.ESCALATED,
        `Handed to a person: ${cause}`,
        null,
      );
      return { stage: 'HUMAN_REVIEW', cause, handoffRecorded: true };
    }
    const fresh = await reloadJourney(ctx);
    if (fresh.state === JourneyState.ESCALATED) return { stage: 'ESCALATED_WAITING' };
    return { stage: 'HUMAN_REVIEW', cause, handoffRecorded: false };
  } catch (error) {
    ctx.deps.logger.error({ err: error, cause }, 'autopilot: could not record the human hand-off');
    return { stage: 'HUMAN_REVIEW', cause, handoffRecorded: false };
  }
}

function decision(
  reason: EscalationDecision['reason'],
  detail: string,
  tier: EscalationDecision['tier'] = EscalationTier.T2,
): EscalationDecision {
  return { tier, reason, detail };
}

async function runAlternatives(
  ctx: Ctx,
  requestedStatus: 'UNAVAILABLE' | 'MAINTENANCE' | 'STILL_LOOKING',
): Promise<JourneyProgress> {
  const response = await recommendAlternatives(
    {
      prisma: ctx.deps.prisma,
      orchestrator: ctx.deps.alternativeRecommendationOrchestrator,
    },
    {
      tenantId: ctx.input.tenantId,
      conversationId: ctx.input.conversationId,
      requestId: ctx.input.requestId,
    },
  );
  await recordAlternativesOutcome(journeyDeps(ctx.deps), {
    tenantId: ctx.input.tenantId,
    conversationId: ctx.input.conversationId,
  });
  return { stage: 'ALTERNATIVES', alternatives: response.alternatives, requestedStatus };
}

/** Step 6 -> Step 8 (or Step 7 when the car is not free). */
async function runAvailabilityAndQuote(ctx: Ctx): Promise<JourneyProgress> {
  const { deps, input } = ctx;
  const availability = await checkAvailability(
    { prisma: deps.prisma, reservationLockService: deps.reservationLockService },
    { tenantId: input.tenantId, conversationId: input.conversationId, requestId: input.requestId },
  );
  await recordAvailabilityOutcome(journeyDeps(deps), {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    status: availability.availability.status,
    retryable: availability.availability.retryable,
    reason: availability.availability.reason ?? null,
    requestId: input.requestId,
  });

  const afterAvailability = await reloadJourney(ctx);
  if (afterAvailability.state === JourneyState.ESCALATED) {
    return { stage: 'HUMAN_REVIEW', cause: 'AVAILABILITY_PROVIDER', handoffRecorded: true };
  }

  const status = availability.availability.status;
  if (status === InventoryStatus.UNAVAILABLE || status === InventoryStatus.MAINTENANCE) {
    return runAlternatives(ctx, status);
  }
  if (status === InventoryStatus.UNKNOWN) {
    // Non-retryable "we cannot tell" — never quote a car we cannot confirm.
    return handOff(
      ctx,
      'AVAILABILITY_PROVIDER',
      decision(
        EscalationReason.AVAILABILITY_PROVIDER_FAILURE,
        availability.availability.reason ?? 'Availability could not be determined',
      ),
    );
  }

  // AVAILABLE / HELD / BOOKED: the car is ours to quote.
  const quoted = await createQuote(
    {
      prisma: deps.prisma,
      rules: deps.pricingRules,
      integritySecret: deps.integritySecret,
    },
    {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      requestId: input.requestId,
      selections: quoteSelectionsSchema.parse({}),
    },
  );
  await recordQuoteOutcome(journeyDeps(deps), {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    status: quoted.quote.status,
    reviewReasons: quoted.quote.reviewReasons,
    requestId: input.requestId,
  });

  const afterQuote = await reloadJourney(ctx);
  if (afterQuote.state === JourneyState.ESCALATED || quoted.quote.status !== QuoteStatus.ISSUED) {
    return { stage: 'HUMAN_REVIEW', cause: 'QUOTE_REVIEW', handoffRecorded: true };
  }

  await recordCrmEvent(
    ctx,
    CustomerTimelineEventType.QUOTE_ISSUED,
    `Quote issued: ${quoted.quote.total.minorUnits / 100} ${quoted.quote.currency}`,
    quoted.quote.quoteId,
  );
  return {
    stage: 'QUOTE_ISSUED',
    quote: quoted.quote,
    holdExpiresAt: availability.availability.hold?.expiresAt ?? null,
  };
}

/** Step 5, then straight on to Steps 6-8 when the customer is eligible. */
async function runEligibility(ctx: Ctx): Promise<JourneyProgress> {
  const { deps, input } = ctx;
  const intake = await collectEligibilityIntake(
    { prisma: deps.prisma, aiProvider: deps.aiProvider, piiKey: deps.piiKey, logger: deps.logger },
    { tenantId: input.tenantId, conversationId: input.conversationId },
  );

  if (!intake.complete || !intake.customerInput) {
    const outbound = await findOutboundMessagesForConversation(
      deps.prisma,
      input.tenantId,
      input.conversationId,
    );
    const asks = outbound.filter((message) => message.stage === 'NEEDS_ELIGIBILITY_INFO').length;
    if (asks >= ELIGIBILITY_ASK_LIMIT) {
      return handOff(
        ctx,
        'DETAILS_STALLED',
        decision(
          EscalationReason.MISSING_INFO_STALLED,
          `Customer has not provided their driver details after ${asks} requests`,
        ),
      );
    }
    await markIntakeRequested(
      { prisma: deps.prisma },
      { tenantId: input.tenantId, conversationId: input.conversationId },
    );
    return {
      stage: 'NEEDS_ELIGIBILITY_INFO',
      missing: intake.missing,
      dateOfBirthAmbiguous: intake.dateOfBirthAmbiguous,
      firstAsk: !intake.askedBefore,
    };
  }

  const eligibility = await checkEligibility(
    { prisma: deps.prisma, orchestrator: deps.eligibilityOrchestrator },
    {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      requestId: input.requestId,
      body: { customer: intake.customerInput, additionalDrivers: [] },
    },
  );
  await recordEligibilityOutcome(journeyDeps(deps), {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    status: eligibility.decision.status,
    reason: eligibility.decision.reason,
    requestId: input.requestId,
  });

  const afterEligibility = await reloadJourney(ctx);
  if (afterEligibility.state === JourneyState.ESCALATED) {
    return { stage: 'HUMAN_REVIEW', cause: 'ELIGIBILITY_REVIEW', handoffRecorded: true };
  }
  if (eligibility.decision.status === EligibilityDecisionStatus.INELIGIBLE) {
    return { stage: 'ELIGIBILITY_DECLINED', reason: eligibility.decision.reason };
  }
  return runAvailabilityAndQuote({ ...ctx, journey: afterEligibility });
}

/** A customer who has been offered alternatives: keep offering them, or move on if they picked another car. */
async function runOfferingAlternatives(ctx: Ctx): Promise<JourneyProgress> {
  const prior = await findLatestAlternativeRecommendationForConversation(
    ctx.deps.prisma,
    ctx.input.tenantId,
    ctx.input.conversationId,
  );
  const currentVehicleId = ctx.input.collected.vehicle?.id ?? null;
  if (prior && currentVehicleId !== null && prior.requestedVehicleId === currentVehicleId) {
    return runAlternatives(ctx, 'STILL_LOOKING');
  }
  return runAvailabilityAndQuote(ctx);
}

/** A quote is out. Acceptance hands over to a person (Steps 9-19 are not automated); anything else is a question about it. */
async function runQuoteFollowUp(ctx: Ctx): Promise<JourneyProgress> {
  const { deps, input } = ctx;
  let quote;
  try {
    quote = (
      await getQuote(
        { prisma: deps.prisma, validator: deps.quoteValidator },
        { tenantId: input.tenantId, conversationId: input.conversationId },
      )
    ).quote;
  } catch (error) {
    const expired =
      isAppError(error) &&
      (error.details as { code?: string } | undefined)?.code === QuoteErrorCode.QUOTE_EXPIRED;
    return handOff(
      ctx,
      expired ? 'QUOTE_EXPIRED' : 'PROCESSING_ERROR',
      decision(
        EscalationReason.AI_UNABLE_TO_PROCEED,
        expired
          ? 'The customer replied after their quote expired and needs a fresh quote'
          : 'The issued quote could not be re-read for the customer',
      ),
    );
  }

  if (acceptsQuote(input.customerMessage)) {
    return handOff(
      ctx,
      'BOOKING_HANDOFF',
      decision(
        EscalationReason.AI_UNABLE_TO_PROCEED,
        `Customer accepted quote ${quote.quoteId}; documents, payment and confirmation are handled by a person`,
      ),
    );
  }
  return { stage: 'QUOTE_FOLLOWUP', quote, holdExpiresAt: null };
}

async function advance(ctx: Ctx): Promise<JourneyProgress> {
  const { journey, input } = ctx;

  if (journey.state === JourneyState.ESCALATED) {
    // An escalation raised only because the customer stalled on booking
    // details is a heads-up to staff, not a hand-over: keep guiding the
    // customer through Step 4, and once they finish it put the journey back
    // on the automatic track. Every other escalation belongs to a person.
    const stalled = await isStalledInfoEscalation(journeyDeps(ctx.deps), {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
    });
    if (!stalled || wantsHuman(input.customerMessage)) return { stage: 'ESCALATED_WAITING' };
    if (input.missingInfoStatus !== 'COMPLETE') return { stage: 'STEP4_PENDING' };
    const resumed = await resumeStalledJourney(journeyDeps(ctx.deps), {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      requestId: input.requestId,
    });
    if (!resumed) return { stage: 'STEP4_PENDING' };
    return advance({ ...ctx, journey: resumed });
  }
  if (isTerminalState(journey.state)) return { stage: 'CLOSED', state: journey.state };

  if (wantsHuman(input.customerMessage)) {
    return handOff(
      ctx,
      'CUSTOMER_REQUESTED',
      decision(EscalationReason.AI_UNABLE_TO_PROCEED, 'Customer asked to speak with a person'),
    );
  }
  if (input.intentType === 'COMPLAINT') {
    return handOff(
      ctx,
      'COMPLAINT',
      decision(
        EscalationReason.CUSTOMER_COMPLAINT,
        'Customer message was classified as a complaint',
        EscalationTier.T3,
      ),
    );
  }

  switch (journey.state) {
    case JourneyState.ELIGIBILITY_CHECK:
      return runEligibility(ctx);
    case JourneyState.AVAILABILITY_CHECK:
      return runAvailabilityAndQuote(ctx);
    case JourneyState.OFFERING_ALTERNATIVES:
      return runOfferingAlternatives(ctx);
    case JourneyState.QUOTE_ISSUED:
      return runQuoteFollowUp(ctx);
    case JourneyState.ENQUIRY_RECEIVED:
    case JourneyState.EXTRACTING_REQUIREMENTS:
    case JourneyState.VEHICLE_SELECTION:
    case JourneyState.COLLECTING_MISSING_INFO:
      return { stage: 'STEP4_PENDING' };
    default:
      return { stage: 'LATER_STAGE', state: journey.state };
  }
}

/**
 * The automatic Steps 5-8 chain. Called once per inbound customer message,
 * right after Steps 1-4 and the journey sync, it moves the journey as far as
 * it can go on its own — collect driver details, check eligibility, check and
 * hold availability, then either quote the car or offer alternatives — and
 * reports where it stopped as a `JourneyProgress`.
 *
 * Every hop reuses the exact same step service and `record*Outcome` function
 * the manual REST endpoints use, so a journey advanced here is
 * indistinguishable (same rows, same audit events, same escalation rules,
 * same dashboard timeline) from one advanced by staff calling the endpoints.
 * Anything unexpected — a missing eligibility policy, a fleet provider
 * failure, an expired quote — becomes a human hand-off rather than a silent
 * stall or a fabricated answer. Never throws: the customer always gets a reply.
 */
export async function advanceJourneyAutomatically(
  deps: JourneyAutopilotDeps,
  input: AdvanceJourneyInput,
): Promise<JourneyProgress> {
  const ctx: Ctx = { deps, input, journey: input.journey };
  try {
    return await advance(ctx);
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        conversationId: input.conversationId,
        journeyState: input.journey.state,
        errorCode: isAppError(error) ? error.code : undefined,
      },
      'autopilot: automatic step failed, handing the journey to a person',
    );
    return handOff(
      ctx,
      'PROCESSING_ERROR',
      decision(
        EscalationReason.AI_UNABLE_TO_PROCEED,
        `Automatic processing failed at ${input.journey.state}${isAppError(error) ? ` (${error.code})` : ''}`,
      ),
    );
  }
}
