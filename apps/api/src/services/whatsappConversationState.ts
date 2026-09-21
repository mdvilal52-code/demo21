import {
  ShortReplyIntent,
  classifyShortReply,
  type DateLocationExtractionOrchestrator,
  type DateLocationSnapshot,
  type MissingInfoOrchestrator,
  type VehicleDeterminationOrchestrator,
  type VehicleSnapshot,
} from '@ai-concierge/ai';
import {
  createMissingInfoCheck,
  findDateLocationExtractionsForConversation,
  findVehicleDeterminationsForConversation,
  toDomainVehicle,
  PrismaAuditWriter,
  type ConversationStage,
  type PrismaClient,
} from '@ai-concierge/db';
import {
  RequiredField,
  type Ambiguity,
  type IntentResult,
  type MissingInfoResult,
  type NormalizedLocation,
  type TenantId,
  type ValidationIssue,
  type VehicleAmbiguity,
  type VehicleValidationError,
} from '@ai-concierge/domain';
import { extractDatesAndLocation } from './dateLocationService.js';
import { determineVehicle } from './vehicleService.js';
import {
  buildWhatsAppReplyText,
  WHATSAPP_BOOKING_DECLINED_REPLY,
  WHATSAPP_BOOKING_INVITATION_REPLY,
  WHATSAPP_CONFIRMATION_NUDGE_REPLY,
  WHATSAPP_WHICH_CAR_REPLY,
} from './whatsappReply.js';

export interface ConversationPipelineDeps {
  prisma: PrismaClient;
  dateLocationOrchestrator: DateLocationExtractionOrchestrator;
  vehicleOrchestrator: VehicleDeterminationOrchestrator;
  missingInfoOrchestrator: MissingInfoOrchestrator;
}

export interface WhatsAppConversationContext {
  tenantId: TenantId;
  requestId: string;
  conversationId: string;
  /** The conversation's stage *before* this message — never mutated in place. */
  stage: ConversationStage;
  /** Start of the conversation's *current* booking cycle, before this message. */
  cycleStartedAt: Date;
  /** Step 1's classification of the raw text that was just appended. */
  intent: IntentResult;
  messageText: string;
}

export interface WhatsAppConversationOutcome {
  replyText: string;
  nextStage: ConversationStage;
  /** Persist this back onto the conversation alongside `nextStage`. */
  nextCycleStartedAt: Date;
}

/**
 * A message "looks like a booking request" on its own — either Step 1's
 * keyword lexicon recognized it (BOOKING_REQUEST) or it at least named a
 * vehicle. Used to let a customer skip the confirmation question when they
 * jump straight to specifics, in whatever stage they're in.
 */
function looksLikeBookingMessage(intent: IntentResult): boolean {
  return intent.intentType === 'BOOKING_REQUEST' || Boolean(intent.entities.vehicleIntent);
}

type DateLocationExtractionRow = Awaited<
  ReturnType<typeof findDateLocationExtractionsForConversation>
>[number];

/**
 * Folds every Step 2 run in the conversation's *current cycle* into one
 * snapshot, taking the latest non-null value per field — so a date given in
 * one message and a location given in a later one both survive, instead of
 * only ever seeing whichever message ran last (which is all a
 * single-message-scoped read, as Step 2's own REST endpoint does, could ever
 * see). Rows are already scoped to `since: cycleStartedAt` by the caller, so
 * a previous, finished booking cycle's dates never leak into this one.
 */
function mergeDateLocationSnapshot(rows: DateLocationExtractionRow[]): DateLocationSnapshot | null {
  if (rows.length === 0) return null;

  let pickupDate: string | null = null;
  let returnDate: string | null = null;
  let pickupLocation: NormalizedLocation | null = null;
  let dropoffLocation: NormalizedLocation | null = null;
  let promptInjectionDetected = false;

  for (const row of rows) {
    if (row.pickupDate) pickupDate = row.pickupDate.toISOString();
    if (row.returnDate) returnDate = row.returnDate.toISOString();
    if (row.pickupLocation) pickupLocation = row.pickupLocation as NormalizedLocation;
    if (row.dropoffLocation) dropoffLocation = row.dropoffLocation as NormalizedLocation;
    if ((row.flags as { promptInjectionDetected: boolean }).promptInjectionDetected) {
      promptInjectionDetected = true;
    }
  }

  // Ambiguity/validation-error messaging comes from the latest run only —
  // an earlier row's now-resolved complaint shouldn't keep being surfaced.
  const latest = rows[rows.length - 1]!;
  return {
    pickupDate,
    returnDate,
    pickupLocation,
    dropoffLocation,
    ambiguities: latest.ambiguities as unknown as Ambiguity[],
    validationErrors: latest.validationErrors as unknown as ValidationIssue[],
    promptInjectionDetected,
  };
}

type VehicleDeterminationRow = Awaited<
  ReturnType<typeof findVehicleDeterminationsForConversation>
>[number];

/**
 * Folds every Step 3 run in the conversation's *current cycle* into one
 * snapshot: the most recent message that actually resolved a real vehicle
 * wins, even if a later message (e.g. one only giving dates) didn't mention
 * a vehicle at all and would otherwise look unresolved again — but a newer
 * resolution (the customer naming a different car) always takes over from
 * an older one, since this scans from the newest row backward.
 */
function mergeVehicleSnapshot(rows: VehicleDeterminationRow[]): VehicleSnapshot | null {
  if (rows.length === 0) return null;

  const resolved = [...rows]
    .reverse()
    .find((row) => row.status === 'RESOLVED' && row.resolvedVehicle);
  const chosen = resolved ?? rows[rows.length - 1]!;
  const promptInjectionDetected = rows.some(
    (row) => (row.flags as { promptInjectionDetected: boolean }).promptInjectionDetected,
  );

  return {
    status: chosen.status,
    resolvedVehicle: chosen.resolvedVehicle ? toDomainVehicle(chosen.resolvedVehicle) : null,
    ambiguities: chosen.ambiguities as unknown as VehicleAmbiguity[],
    validationErrors: chosen.validationErrors as unknown as VehicleValidationError[],
    promptInjectionDetected,
  };
}

function nextStageForMissingInfo(missingInfo: MissingInfoResult): ConversationStage {
  if (missingInfo.status === 'COMPLETE') return 'COMPLETE';
  // The current cycle's 24h window passed with the request still
  // incomplete — the reply itself invites the customer to start over, so
  // the next message should begin a fresh cycle too.
  if (missingInfo.status === 'EXPIRED') return 'NEW';
  const vehicleStillMissing = missingInfo.missingFields.some(
    (field) => field.field === RequiredField.VEHICLE,
  );
  return vehicleStillMissing ? 'COLLECTING_VEHICLE' : 'COLLECTING_DETAILS';
}

/**
 * Runs Steps 2-3 on the message just appended, merges the resulting
 * *current-cycle* history with everything already known so far this cycle,
 * and evaluates Step 4 directly — with intent forced to BOOKING_REQUEST,
 * since by the time this runs the stage machine already knows (from
 * conversation stage, not from re-classifying this one message) that the
 * customer is mid-booking. This is the same `MissingInfoOrchestrator` Step
 * 4's own REST endpoint uses; only how its input is gathered differs
 * (conversation-wide here vs. single-message there), because a
 * REST-created conversation never has more than one message today, so that
 * endpoint's own behavior is unaffected.
 */
async function runBookingPipeline(
  deps: ConversationPipelineDeps,
  ctx: WhatsAppConversationContext,
  cycleStartedAt: Date,
): Promise<WhatsAppConversationOutcome> {
  const dateLocationResult = await extractDatesAndLocation(
    { prisma: deps.prisma, orchestrator: deps.dateLocationOrchestrator },
    { tenantId: ctx.tenantId, conversationId: ctx.conversationId, requestId: ctx.requestId },
  );
  await determineVehicle(
    { prisma: deps.prisma, orchestrator: deps.vehicleOrchestrator },
    { tenantId: ctx.tenantId, conversationId: ctx.conversationId, requestId: ctx.requestId },
  );

  const [dateLocationRows, vehicleRows] = await Promise.all([
    findDateLocationExtractionsForConversation(
      deps.prisma,
      ctx.tenantId,
      ctx.conversationId,
      cycleStartedAt,
    ),
    findVehicleDeterminationsForConversation(
      deps.prisma,
      ctx.tenantId,
      ctx.conversationId,
      cycleStartedAt,
    ),
  ]);

  const messageId = dateLocationResult.messageId;

  const missingInfo = deps.missingInfoOrchestrator.evaluate({
    intent: {
      intentType: 'BOOKING_REQUEST',
      promptInjectionDetected: ctx.intent.flags.promptInjectionDetected,
    },
    dateLocation: mergeDateLocationSnapshot(dateLocationRows),
    vehicle: mergeVehicleSnapshot(vehicleRows),
    // The 24h "loop until complete or timeout" clock is scoped to the
    // *current* booking cycle, not the conversation row's all-time
    // createdAt — otherwise a customer's second, unrelated request in the
    // same preserved thread would read as EXPIRED before it even started.
    conversationCreatedAt: cycleStartedAt,
    now: new Date(),
  });

  await deps.prisma.$transaction(async (tx) => {
    await createMissingInfoCheck(tx, {
      tenantId: ctx.tenantId,
      messageId,
      result: missingInfo,
    });

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: ctx.tenantId,
      actor: 'system:whatsapp-missing-info-check',
      action: 'missing_info.checked',
      entityType: 'Message',
      entityId: messageId,
      after: {
        status: missingInfo.status,
        missingFieldCount: missingInfo.missingFields.length,
      },
      requestId: ctx.requestId,
    });
  });

  return {
    replyText: buildWhatsAppReplyText(missingInfo),
    nextStage: nextStageForMissingInfo(missingInfo),
    nextCycleStartedAt: cycleStartedAt,
  };
}

/**
 * The WhatsApp channel adapter's conversation-stage machine — the fix for
 * "Yes" repeating the initial greeting. A conversation's stage says what
 * question (if any) the bot is waiting on an answer to, so a short reply is
 * interpreted using that context instead of being re-classified from
 * scratch by Step 1's keyword lexicon (which has no way to know "Yes" means
 * "yes, I want to book a car" — it carries no booking keyword on its own).
 *
 * `COMPLETE` is treated as `NEW` for branching (a finished booking flow
 * naturally restarts on the next message) while still appending to the same
 * conversation, so history is preserved per customer as required — but it
 * also starts a fresh *cycle* (`cycleStartedAt` reset to now), so the next
 * booking's merge and timeout clock never see the finished one's data.
 */
export async function advanceWhatsAppConversation(
  deps: ConversationPipelineDeps,
  ctx: WhatsAppConversationContext,
): Promise<WhatsAppConversationOutcome> {
  const effectiveStage: ConversationStage = ctx.stage === 'COMPLETE' ? 'NEW' : ctx.stage;
  const cycleStartedAt = ctx.stage === 'COMPLETE' ? new Date() : ctx.cycleStartedAt;

  switch (effectiveStage) {
    case 'NEW': {
      if (looksLikeBookingMessage(ctx.intent)) {
        return runBookingPipeline(deps, ctx, cycleStartedAt);
      }
      return {
        replyText: WHATSAPP_BOOKING_INVITATION_REPLY,
        nextStage: 'AWAITING_BOOKING_CONFIRMATION',
        nextCycleStartedAt: cycleStartedAt,
      };
    }

    case 'AWAITING_BOOKING_CONFIRMATION': {
      // The customer skipped confirming and went straight to specifics
      // (e.g. "Lamborghini Urus please") — honor that instead of asking a
      // question they already answered.
      if (looksLikeBookingMessage(ctx.intent)) {
        return runBookingPipeline(deps, ctx, cycleStartedAt);
      }
      const shortReply = classifyShortReply(ctx.messageText);
      if (shortReply === ShortReplyIntent.AFFIRMATIVE) {
        return {
          replyText: WHATSAPP_WHICH_CAR_REPLY,
          nextStage: 'COLLECTING_VEHICLE',
          nextCycleStartedAt: cycleStartedAt,
        };
      }
      if (shortReply === ShortReplyIntent.NEGATIVE) {
        return {
          replyText: WHATSAPP_BOOKING_DECLINED_REPLY,
          nextStage: 'NEW',
          nextCycleStartedAt: cycleStartedAt,
        };
      }
      // Neither yes/no nor booking-shaped — nudge once, never repeat the
      // original greeting/invitation.
      return {
        replyText: WHATSAPP_CONFIRMATION_NUDGE_REPLY,
        nextStage: 'AWAITING_BOOKING_CONFIRMATION',
        nextCycleStartedAt: cycleStartedAt,
      };
    }

    case 'COLLECTING_VEHICLE':
    case 'COLLECTING_DETAILS':
      return runBookingPipeline(deps, ctx, cycleStartedAt);

    default:
      // Unreachable: COMPLETE was normalized to NEW above. Kept only to
      // satisfy TypeScript's exhaustiveness check over ConversationStage.
      return {
        replyText: WHATSAPP_BOOKING_INVITATION_REPLY,
        nextStage: 'AWAITING_BOOKING_CONFIRMATION',
        nextCycleStartedAt: cycleStartedAt,
      };
  }
}
