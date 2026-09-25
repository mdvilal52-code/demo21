import { createHash } from 'node:crypto';
import { parseMailgunInboundEmail, verifyMailgunSignature } from '@ai-concierge/channels';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  releaseIdempotencyKeyClaim,
  findMessagesForConversation,
  PrismaAuditWriter,
  type Channel,
} from '@ai-concierge/db';
import { AppError, CustomerTimelineEventType } from '@ai-concierge/domain';
import { emailInboundAckResponseSchema } from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppContext } from '../../context.js';
import { flagUnexpectedPiiInOutboundText } from '../../lib/dlp.js';
import {
  generateConversationalReply,
  MAX_RECENT_TURNS_FOR_REPLY,
  type RecentTurn,
} from '../../services/conversationalReplyService.js';
import {
  runFullEnquiryPipeline,
  type FullEnquiryPipelineResult,
} from '../../services/enquiryPipelineService.js';
import { syncJourneyAfterMissingInfo } from '../../services/journeyService.js';
import { syncCustomerFromJourney } from '../../services/crmService.js';

const EMAIL_CHANNEL: Channel = 'EMAIL';

/**
 * Same structured-decision-logging discipline as `whatsapp.ts`'s
 * `logPipelineDecision` — never the message body, only opaque ids and
 * classification outcomes.
 */
function logPipelineDecision(
  ctx: AppContext,
  requestId: string,
  pipeline: FullEnquiryPipelineResult,
): void {
  const intent = pipeline.enquiry.intent;
  const missingInfo = pipeline.missingInfo.missingInfo;
  ctx.logger.info(
    {
      requestId,
      conversationId: pipeline.enquiry.conversationId,
      messageId: pipeline.enquiry.messageId,
      intentType: intent.intentType,
      intentStatus: intent.status,
      decisionEngine: intent.modelMetadata.engine,
      stage: missingInfo.status,
      missingFields: missingInfo.missingFields.map((field) => ({
        field: field.field,
        reason: field.reason,
      })),
      promptInjectionDetected: missingInfo.flags.promptInjectionDetectedAnywhere,
    },
    'email pipeline decision',
  );
}

/**
 * Steps 1-4, automatically, for one inbound email, then replies with
 * whatever Step 4 actually determined — the exact same pipeline, journey
 * sync, CRM sync, and Gemini-grounded reply generation as
 * `whatsapp.ts`'s `processInboundMessage`, just over the Email channel.
 * Idempotency mirrors WhatsApp's own claim-before-work discipline: Mailgun
 * retries an inbound-webhook delivery that doesn't 200 fast enough, so the
 * key is claimed atomically before any work starts, not checked-then-saved
 * at the end (see whatsapp.ts's own doc for why that window matters).
 */
async function processInboundEmail(
  ctx: AppContext,
  inbound: { messageId: string; from: string; subject: string; body: string },
  requestId: string,
): Promise<void> {
  const idempotencyKey = `email:${inbound.messageId}`;
  const claimed = await claimIdempotencyKey(ctx.prisma, {
    key: idempotencyKey,
    tenantId: ctx.config.DEFAULT_TENANT_ID,
    requestHash: createHash('sha256').update(inbound.body).digest('hex'),
  });
  if (!claimed) {
    ctx.logger.info({ idempotencyKey }, 'email webhook: duplicate delivery, skipping');
    return;
  }

  try {
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
        tenantId: ctx.config.DEFAULT_TENANT_ID,
        channel: EMAIL_CHANNEL,
        customerRef: inbound.from,
        message: inbound.body,
        requestId,
      },
    );

    logPipelineDecision(ctx, requestId, pipeline);

    // Best-effort journey/CRM tracking — same "never let this reach the
    // outer catch" reasoning as whatsapp.ts: that catch releases the
    // idempotency claim and rethrows, which would make Mailgun redeliver
    // and re-send the reply a second time for an unrelated failure.
    try {
      const journey = await syncJourneyAfterMissingInfo(
        { prisma: ctx.prisma, notificationProvider: ctx.notificationProvider },
        {
          tenantId: ctx.config.DEFAULT_TENANT_ID,
          conversationId: pipeline.enquiry.conversationId,
          messageId: pipeline.enquiry.messageId,
          resolvedVehicleId: pipeline.vehicle.determination.resolvedVehicle?.id ?? null,
          missingInfoStatus: pipeline.missingInfo.missingInfo.status,
          requestId,
        },
      );
      await syncCustomerFromJourney(
        { prisma: ctx.prisma },
        {
          tenantId: ctx.config.DEFAULT_TENANT_ID,
          conversationId: pipeline.enquiry.conversationId,
          journeyId: journey.id,
          eventType: CustomerTimelineEventType.JOURNEY_STARTED,
          eventSummary: `Journey started on Email (${pipeline.missingInfo.missingInfo.status})`,
          vehicleId: pipeline.vehicle.determination.resolvedVehicle?.id ?? null,
          quoteId: null,
          bookingCompleted: false,
        },
      );
    } catch (error) {
      ctx.logger.error({ err: error }, 'journey/CRM sync failed after email pipeline');
    }

    const conversationMessages = await findMessagesForConversation(
      ctx.prisma,
      ctx.config.DEFAULT_TENANT_ID,
      pipeline.enquiry.conversationId,
    );
    const recentTurns: RecentTurn[] = conversationMessages
      .slice(-MAX_RECENT_TURNS_FOR_REPLY)
      .map((row) => ({ role: 'customer', content: row.content }));

    const reply = await generateConversationalReply(
      { aiProvider: ctx.aiProvider, logger: ctx.logger },
      { missingInfo: pipeline.missingInfo.missingInfo, recentTurns },
    );
    const replyText = reply.text;

    await flagUnexpectedPiiInOutboundText(
      { prisma: ctx.prisma, logger: ctx.logger },
      { tenantId: ctx.config.DEFAULT_TENANT_ID, channel: EMAIL_CHANNEL, text: replyText },
    );

    const replySubject = inbound.subject.trim().toLowerCase().startsWith('re:')
      ? inbound.subject
      : `Re: ${inbound.subject || 'Your rental enquiry'}`;
    const sendResult = await ctx.emailProvider.sendEmail(inbound.from, replySubject, replyText);

    const auditWriter = new PrismaAuditWriter(ctx.prisma);
    await auditWriter.record({
      tenantId: ctx.config.DEFAULT_TENANT_ID,
      actor: 'channel:email',
      action: 'email.reply_sent',
      entityType: 'Conversation',
      entityId: pipeline.enquiry.conversationId,
      after: {
        sendStatus: sendResult.status,
        missingInfoStatus: pipeline.missingInfo.missingInfo.status,
      },
      requestId,
    });

    await completeIdempotencyKey(ctx.prisma, idempotencyKey, 200, {
      conversationId: pipeline.enquiry.conversationId,
      replyText,
      sendStatus: sendResult.status,
    });
  } catch (error) {
    await releaseIdempotencyKeyClaim(ctx.prisma, idempotencyKey);
    throw error;
  }
}

export const emailWebhookRoutes: FastifyPluginAsyncZod = async (app) => {
  // Mailgun's inbound routing posts `multipart/form-data` by default, but
  // also supports plain `application/x-www-form-urlencoded` when configured
  // without attachments — this project's demo tenant needs neither file
  // uploads nor a new dependency (@fastify/multipart) to parse them, so the
  // webhook URL should be registered with Mailgun as url-encoded. Scoped to
  // this plugin only, same Fastify-encapsulation discipline as whatsapp.ts's
  // own content-type parser.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        const params = new URLSearchParams(body as string);
        done(null, Object.fromEntries(params.entries()));
      } catch {
        const error = new Error('Invalid form-urlencoded body') as Error & { statusCode?: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  app.post(
    '/webhooks/email',
    {
      // Mailgun's own infrastructure IPs, not one per customer — same
      // shared-IP-pool reasoning as the WhatsApp webhook's rate-limit opt-out.
      config: { rateLimit: false },
      schema: {
        tags: ['email'],
        response: { 200: emailInboundAckResponseSchema },
        // No `body` schema: Mailgun's signature must be verified against the
        // parsed timestamp/token/signature fields before the rest of the
        // payload is trusted enough to shape-validate further.
      },
    },
    async (request, reply) => {
      const signingKey = app.ctx.config.MAILGUN_WEBHOOK_SIGNING_KEY;
      if (!signingKey) {
        throw new AppError('NOT_CONFIGURED', 'Email channel is not configured');
      }

      const body = request.body as Record<string, unknown>;
      const timestamp = typeof body.timestamp === 'string' ? body.timestamp : '';
      const token = typeof body.token === 'string' ? body.token : '';
      const signature = typeof body.signature === 'string' ? body.signature : '';
      if (
        !timestamp ||
        !token ||
        !signature ||
        !verifyMailgunSignature(timestamp, token, signature, signingKey)
      ) {
        throw new AppError('UNAUTHORIZED', 'Invalid email webhook signature');
      }

      const inbound = parseMailgunInboundEmail(body);
      if (inbound) {
        await processInboundEmail(app.ctx, inbound, request.id);
      }

      // Mailgun expects a fast 2xx regardless of downstream outcome — a
      // non-2xx here makes Mailgun retry the exact same webhook delivery.
      reply.status(200).send({ received: true });
    },
  );
};
