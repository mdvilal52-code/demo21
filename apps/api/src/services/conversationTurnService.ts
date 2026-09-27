import {
  createOutboundMessage,
  findCustomerByIdentity,
  findMessagesForConversation,
  findOutboundMessagesForConversation,
  type Channel,
  type OutboundMessageSourceValue,
} from '@ai-concierge/db';
import {
  CustomerTimelineEventType,
  type Journey,
  type OutboundAttachment,
  type TenantId,
} from '@ai-concierge/domain';
import type { AppContext } from '../context.js';
import { RedisNotificationLimiter } from '../lib/notificationLimiter.js';
import { resolvePiiKey } from '../lib/piiKey.js';
import { MAX_RECENT_TURNS_FOR_REPLY, type RecentTurn } from './conversationalReplyService.js';
import { captureCustomerContact } from './customerContactService.js';
import { notifyCustomerAfterTurn } from './customerNotificationService.js';
import { syncCustomerFromJourney } from './crmService.js';
import {
  runFullEnquiryPipeline,
  type FullEnquiryPipelineResult,
} from './enquiryPipelineService.js';
import { advanceJourneyAutomatically } from './journeyAutopilotService.js';
import type { JourneyProgress } from './journeyProgress.js';
import { generateJourneyReply, type JourneyReply } from './journeyReplyService.js';
import { syncJourneyAfterMissingInfo } from './journeyService.js';
import { buildPhotoReply } from './vehiclePhotoReplyService.js';

export interface InboundTurnInput {
  channel: Channel;
  /** The customer's identity on the channel (phone number, email address). */
  customerRef: string;
  /** The customer's message text. */
  body: string;
  requestId: string;
}

export interface InboundTurnResult {
  conversationId: string;
  reply: JourneyReply;
  progress: JourneyProgress;
  missingInfoStatus: string;
  /** Car photos to send with the reply (stored as ids; each channel turns them into what it can send). */
  attachments: OutboundAttachment[];
}

/**
 * Asked at most twice per conversation, and only in the website chat — an
 * email or WhatsApp customer is already reachable through the channel itself.
 * Without contact details the team cannot follow up and no quote email or SMS
 * can be sent.
 */
export const CONTACT_REQUEST_TEXT =
  'To receive your quote by email or SMS, and so our team can reach you, please share your email address and phone number (with country code).';
const CONTACT_REQUEST_MARKER = 'please share your email address and phone number';
const MAX_CONTACT_REQUESTS = 2;
const CONTACT_REQUEST_STAGES: JourneyProgress['stage'][] = [
  'QUOTE_ISSUED',
  'QUOTE_FOLLOWUP',
  'HUMAN_REVIEW',
  'ESCALATED_WAITING',
];

/**
 * One line per processed message: ids, intent, stage and the fields still
 * missing — everything needed to debug *why* a reply was sent, without ever
 * logging the message itself. `conversationId`/`messageId` are opaque ids and
 * each `missingFields` entry keeps only `field`/`reason` (never `detail`,
 * which can echo the customer's own text). `ctx.logger`'s redact paths are a
 * second, independent backstop.
 */
function logPipelineDecision(
  ctx: AppContext,
  channel: Channel,
  requestId: string,
  pipeline: FullEnquiryPipelineResult,
  progress: JourneyProgress,
): void {
  const intent = pipeline.enquiry.intent;
  const missingInfo = pipeline.missingInfo.missingInfo;
  ctx.logger.info(
    {
      requestId,
      channel,
      conversationId: pipeline.enquiry.conversationId,
      messageId: pipeline.enquiry.messageId,
      intentType: intent.intentType,
      intentStatus: intent.status,
      decisionEngine: intent.modelMetadata.engine,
      stage: missingInfo.status,
      journeyProgress: progress.stage,
      missingFields: missingInfo.missingFields.map((field) => ({
        field: field.field,
        reason: field.reason,
      })),
      promptInjectionDetected: missingInfo.flags.promptInjectionDetectedAnywhere,
    },
    'inbound pipeline decision',
  );
}

/** Both sides of the conversation, oldest first, capped to what the reply prompt needs. */
async function loadTurns(
  ctx: AppContext,
  tenantId: TenantId,
  conversationId: string,
): Promise<RecentTurn[]> {
  const [customerMessages, outboundMessages] = await Promise.all([
    findMessagesForConversation(ctx.prisma, tenantId, conversationId),
    findOutboundMessagesForConversation(
      ctx.prisma,
      tenantId,
      conversationId,
      MAX_RECENT_TURNS_FOR_REPLY,
    ),
  ]);
  return [
    ...customerMessages.map((row) => ({
      role: 'customer' as const,
      content: row.content,
      at: row.createdAt.getTime(),
    })),
    ...outboundMessages.map((row) => ({
      role: 'assistant' as const,
      content: row.content,
      at: row.createdAt.getTime(),
    })),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_RECENT_TURNS_FOR_REPLY)
    .map(({ role, content }) => ({ role, content }));
}

/**
 * Everything that happens between "a customer message arrived" and "here is
 * the reply to send", identical for every channel: Steps 1-4, the persisted
 * journey and CRM sync, the automatic Steps 5-8 chain, and the reply itself.
 * Each channel webhook keeps only what is genuinely channel-specific —
 * signature verification, the idempotency claim, and the actual send.
 *
 * The journey/CRM sync is best-effort and caught locally, never allowed to
 * fail the turn: a failure there must not make the channel redeliver the
 * webhook and re-send a reply the customer already got.
 */
export async function handleInboundTurn(
  ctx: AppContext,
  input: InboundTurnInput,
): Promise<InboundTurnResult> {
  const tenantId = ctx.config.DEFAULT_TENANT_ID;

  const pipeline = await runFullEnquiryPipeline(
    {
      prisma: ctx.prisma,
      intentEngine: ctx.intentEngine,
      postEnquiryQueue: ctx.postEnquiryQueue,
      dateLocationOrchestrator: ctx.dateLocationOrchestrator,
      vehicleOrchestrator: ctx.vehicleOrchestrator,
      missingInfoOrchestrator: ctx.missingInfoOrchestrator,
    },
    {
      tenantId,
      channel: input.channel,
      customerRef: input.customerRef,
      message: input.body,
      requestId: input.requestId,
    },
  );
  const conversationId = pipeline.enquiry.conversationId;
  const missingInfo = pipeline.missingInfo.missingInfo;

  // Contact details the customer typed (or the channel itself is) go straight to the CRM.
  try {
    await captureCustomerContact(
      { prisma: ctx.prisma },
      {
        tenantId,
        channel: input.channel,
        customerRef: input.customerRef,
        message: input.body,
      },
    );
  } catch (error) {
    ctx.logger.error({ err: error }, 'could not save customer contact details');
  }

  let journey: Journey | null = null;
  try {
    journey = await syncJourneyAfterMissingInfo(
      { prisma: ctx.prisma, notificationProvider: ctx.notificationProvider },
      {
        tenantId,
        conversationId,
        messageId: pipeline.enquiry.messageId,
        resolvedVehicleId: pipeline.vehicle.determination.resolvedVehicle?.id ?? null,
        missingInfoStatus: missingInfo.status,
        requestId: input.requestId,
      },
    );
    await syncCustomerFromJourney(
      { prisma: ctx.prisma },
      {
        tenantId,
        conversationId,
        journeyId: journey.id,
        eventType: CustomerTimelineEventType.JOURNEY_STARTED,
        eventSummary: `Journey started on ${input.channel} (${missingInfo.status})`,
        vehicleId: pipeline.vehicle.determination.resolvedVehicle?.id ?? null,
        quoteId: null,
        bookingCompleted: false,
      },
    );
  } catch (error) {
    ctx.logger.error({ err: error }, 'journey/CRM sync failed after inbound pipeline');
  }

  // The automatic Steps 5-8 chain. Without a journey (the sync above failed)
  // there is nothing to advance, so the customer just gets the Step 4 reply.
  const progress: JourneyProgress = journey
    ? await advanceJourneyAutomatically(
        {
          prisma: ctx.prisma,
          notificationProvider: ctx.notificationProvider,
          aiProvider: ctx.aiProvider,
          logger: ctx.logger,
          eligibilityOrchestrator: ctx.eligibilityOrchestrator,
          reservationLockService: ctx.reservationLockService,
          alternativeRecommendationOrchestrator: ctx.alternativeRecommendationOrchestrator,
          pricingRules: ctx.pricingRules,
          quoteValidator: ctx.quoteValidator,
          integritySecret: ctx.config.WEBHOOK_SIGNING_SECRET,
          piiKey: resolvePiiKey(ctx.config),
        },
        {
          tenantId,
          conversationId,
          requestId: input.requestId,
          journey,
          missingInfoStatus: missingInfo.status,
          collected: missingInfo.collected,
          customerMessage: input.body,
          intentType: pipeline.enquiry.intent.intentType,
        },
      )
    : { stage: 'STEP4_PENDING' };

  logPipelineDecision(ctx, input.channel, input.requestId, pipeline, progress);

  const turns = await loadTurns(ctx, tenantId, conversationId);
  const journeyReply = await generateJourneyReply(
    { aiProvider: ctx.aiProvider, logger: ctx.logger },
    { progress, missingInfo, turns },
  );

  let replyText = journeyReply.text;
  let attachments: OutboundAttachment[] = [];

  // "Send me a photo of the Range Rover": attach the photos staff uploaded for it.
  try {
    const photoReply = await buildPhotoReply(
      { prisma: ctx.prisma },
      {
        tenantId,
        message: input.body,
        resolvedVehicleId: pipeline.vehicle.determination.resolvedVehicle?.id ?? null,
      },
    );
    if (photoReply) {
      replyText = `${photoReply.text}\n\n${replyText}`;
      attachments = photoReply.attachments;
    }
  } catch (error) {
    ctx.logger.error({ err: error }, 'could not build the car photo reply');
  }

  // Ask for an email/phone (website chat only) once a quote or hand-over makes them useful.
  try {
    if (input.channel === 'WEB' && CONTACT_REQUEST_STAGES.includes(progress.stage)) {
      const customer = await findCustomerByIdentity(ctx.prisma, tenantId, {
        channel: input.channel,
        customerRef: input.customerRef,
      });
      const asked = turns.filter(
        (turn) => turn.role === 'assistant' && turn.content.includes(CONTACT_REQUEST_MARKER),
      ).length;
      if (customer && !customer.email && !customer.phone && asked < MAX_CONTACT_REQUESTS) {
        replyText = `${replyText}\n\n${CONTACT_REQUEST_TEXT}`;
      }
    }
  } catch (error) {
    ctx.logger.error({ err: error }, 'could not check whether contact details are needed');
  }

  // Automatic quote / hand-over email and SMS. Never allowed to fail the turn.
  try {
    await notifyCustomerAfterTurn(
      {
        prisma: ctx.prisma,
        emailProvider: ctx.emailProvider,
        notificationProvider: ctx.notificationProvider,
        limiter: new RedisNotificationLimiter(ctx.redis, {
          perRecipientPerDay: ctx.config.NOTIFY_PER_RECIPIENT_PER_DAY,
          globalSmsPerDay: ctx.config.NOTIFY_SMS_GLOBAL_PER_DAY,
          globalEmailPerDay: ctx.config.NOTIFY_EMAIL_GLOBAL_PER_DAY,
        }),
      },
      {
        tenantId,
        conversationId,
        channel: input.channel,
        customerRef: input.customerRef,
        journeyId: journey?.id ?? null,
        progress,
      },
    );
  } catch (error) {
    ctx.logger.error({ err: error }, 'customer notification failed after inbound turn');
  }

  return {
    conversationId,
    reply: { ...journeyReply, text: replyText },
    progress,
    missingInfoStatus: missingInfo.status,
    attachments,
  };
}

/**
 * Persists what the concierge actually told the customer. Called by the
 * channel webhook only after the message was really delivered — recording a
 * reply that never left (channel NOT_CONFIGURED, a send failure) would put
 * words in the conversation history the customer never saw.
 */
export async function recordOutboundReply(
  ctx: AppContext,
  input: {
    conversationId: string;
    text: string;
    source: OutboundMessageSourceValue;
    stage: string;
    attachments?: OutboundAttachment[];
  },
): Promise<void> {
  try {
    await createOutboundMessage(ctx.prisma, {
      tenantId: ctx.config.DEFAULT_TENANT_ID,
      conversationId: input.conversationId,
      content: input.text,
      source: input.source,
      stage: input.stage,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
  } catch (error) {
    ctx.logger.error({ err: error }, 'could not record the outbound reply');
  }
}
