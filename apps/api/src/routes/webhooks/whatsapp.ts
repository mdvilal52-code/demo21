import { createHash, createHmac } from 'node:crypto';
import {
  buildWhatsAppReplyText,
  parseWhatsAppTextMessages,
  verifyMetaSignature,
} from '@ai-concierge/channels';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  releaseIdempotencyKeyClaim,
  PrismaAuditWriter,
  type Channel,
} from '@ai-concierge/db';
import { AppError } from '@ai-concierge/domain';
import {
  whatsappInboundAckResponseSchema,
  whatsappVerifyQuerySchema,
} from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppContext } from '../../context.js';
import { flagUnexpectedPiiInOutboundText } from '../../lib/dlp.js';
import {
  runFullEnquiryPipeline,
  type FullEnquiryPipelineResult,
} from '../../services/enquiryPipelineService.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const WHATSAPP_CHANNEL: Channel = 'WHATSAPP';

/**
 * One structured line per processed message: session id, intent, stage and
 * the fields still missing, plus which decision path Step 1 took (the raw
 * keyword engine, or one of `enquiryService.ts`'s corrections — see
 * `modelMetadata.engine`) — everything needed to debug *why* a given reply
 * was sent, without ever logging the message itself. Deliberately narrow
 * about what it includes: `conversationId`/`messageId` are opaque ids, never
 * the customer's phone number or message text, and each `missingFields`
 * entry keeps only `field`/`reason` — never `detail`, which can echo back a
 * fragment of the customer's own text (e.g. an unmatched vehicle name).
 * `ctx.logger`'s own redact paths (`packages/observability/src/logger.ts`)
 * are a second, independent backstop if a field named message/content ever
 * did end up here.
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
    'whatsapp pipeline decision',
  );
}

/**
 * Steps 1-4, automatically, for one inbound WhatsApp text message, then
 * replies with whatever Step 4 actually determined. Keyed on Meta's own
 * message id, claimed *before* any work starts: the pipeline plus the
 * outbound send can take seconds, and Meta redelivers a webhook that hasn't
 * answered fast enough, so a find-then-save-at-the-end check would leave a
 * wide window for two concurrent deliveries to both run the pipeline and
 * both send a reply. Claiming atomically up front closes that window; on
 * failure the claim is released so a genuine future retry isn't stuck
 * behind a claim that will never complete.
 */
async function processInboundMessage(
  ctx: AppContext,
  inbound: { messageId: string; from: string; body: string },
  requestId: string,
): Promise<void> {
  const idempotencyKey = `whatsapp:${inbound.messageId}`;
  const claimed = await claimIdempotencyKey(ctx.prisma, {
    key: idempotencyKey,
    tenantId: ctx.config.DEFAULT_TENANT_ID,
    requestHash: createHash('sha256').update(inbound.body).digest('hex'),
  });
  if (!claimed) {
    ctx.logger.info({ idempotencyKey }, 'whatsapp webhook: duplicate delivery, skipping');
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
        channel: WHATSAPP_CHANNEL,
        customerRef: inbound.from,
        message: inbound.body,
        requestId,
      },
    );

    logPipelineDecision(ctx, requestId, pipeline);

    const replyText = buildWhatsAppReplyText(pipeline.missingInfo.missingInfo);

    await flagUnexpectedPiiInOutboundText(
      { prisma: ctx.prisma, logger: ctx.logger },
      { tenantId: ctx.config.DEFAULT_TENANT_ID, channel: WHATSAPP_CHANNEL, text: replyText },
    );

    const sendResult = await ctx.whatsappProvider.sendTextMessage(inbound.from, replyText);

    const auditWriter = new PrismaAuditWriter(ctx.prisma);
    await auditWriter.record({
      tenantId: ctx.config.DEFAULT_TENANT_ID,
      actor: 'channel:whatsapp',
      action: 'whatsapp.reply_sent',
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

export const whatsappWebhookRoutes: FastifyPluginAsyncZod = async (app) => {
  // Capture the exact bytes Meta sent — HMAC verification must run against
  // the raw body, never a re-serialized copy of the parsed JSON. Scoped to
  // this plugin only (Fastify encapsulation): every other route keeps the
  // default JSON parser untouched.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const buffer = body as Buffer;
    request.rawBody = buffer;
    if (buffer.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(buffer.toString('utf8')));
    } catch {
      const error = new Error('Invalid JSON body') as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  app.get(
    '/webhooks/whatsapp',
    {
      // Meta calls this from a shared IP pool serving every customer's
      // messages, not one IP per customer — the app-wide per-IP rate limit
      // is the wrong shape here and would throttle the whole business.
      config: { rateLimit: false },
      schema: { tags: ['whatsapp'], querystring: whatsappVerifyQuerySchema },
    },
    async (request, reply) => {
      const configuredToken = app.ctx.config.WHATSAPP_VERIFY_TOKEN;
      if (!configuredToken) {
        throw new AppError('NOT_CONFIGURED', 'WhatsApp channel is not configured');
      }

      const {
        'hub.mode': mode,
        'hub.verify_token': token,
        'hub.challenge': challenge,
      } = request.query;
      if (mode !== 'subscribe' || token !== configuredToken) {
        throw new AppError('FORBIDDEN', 'WhatsApp webhook verification failed');
      }

      reply.status(200).type('text/plain').send(challenge);
    },
  );

  app.post(
    '/webhooks/whatsapp',
    {
      // Same shared-IP-pool reasoning as the GET route above — this is the
      // route that actually matters for it, since a throttled 429 here
      // reads to Meta as a failed delivery and triggers a redelivery storm.
      config: { rateLimit: false },
      schema: {
        tags: ['whatsapp'],
        response: { 200: whatsappInboundAckResponseSchema },
        // Deliberately no `body` schema: the signature must be verified
        // against the raw bytes before the payload is trusted enough to
        // even shape-validate (see the content-type parser above).
      },
    },
    async (request, reply) => {
      const appSecret = app.ctx.config.WHATSAPP_APP_SECRET;
      if (!appSecret) {
        throw new AppError('NOT_CONFIGURED', 'WhatsApp channel is not configured');
      }

      const signatureHeader = request.headers['x-hub-signature-256'];
      const rawBody = request.rawBody?.toString('utf8') ?? '';
      if (
        typeof signatureHeader !== 'string' ||
        !verifyMetaSignature(rawBody, signatureHeader, appSecret)
      ) {
        // Temporary diagnostics for the current live signature-mismatch
        // investigation — remove once root-caused. None of this exposes
        // appSecret itself: an HMAC digest can't be reversed to the key it
        // was computed with, so logging both digests side by side is safe
        // and is the fastest way to tell "wrong secret" apart from "this
        // traffic was never signed by Meta at all".
        request.log.warn(
          {
            userAgent: request.headers['user-agent'],
            remoteIp: request.ip,
            contentType: request.headers['content-type'],
            rawBodyLength: rawBody.length,
            rawBodyPreview: rawBody.slice(0, 300),
            receivedSignatureHeader: signatureHeader ?? null,
            expectedSignatureHeader: `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`,
          },
          'WhatsApp webhook signature mismatch — diagnostics',
        );
        throw new AppError('UNAUTHORIZED', 'Invalid WhatsApp webhook signature');
      }

      const messages = parseWhatsAppTextMessages(request.body);
      for (const inbound of messages) {
        await processInboundMessage(app.ctx, inbound, request.id);
      }

      // Meta expects a fast 2xx regardless of downstream outcome — a
      // non-2xx here makes Meta retry the exact same webhook delivery.
      reply.status(200).send({ received: true });
    },
  );
};
