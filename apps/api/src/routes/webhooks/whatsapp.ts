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
import { runFullEnquiryPipeline } from '../../services/enquiryPipelineService.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const WHATSAPP_CHANNEL: Channel = 'WHATSAPP';

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

    const replyText = buildWhatsAppReplyText(pipeline.missingInfo.missingInfo);
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
    { schema: { tags: ['whatsapp'], querystring: whatsappVerifyQuerySchema } },
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
