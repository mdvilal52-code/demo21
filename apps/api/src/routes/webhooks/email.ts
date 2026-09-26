import { createHash } from 'node:crypto';
import { parseMailgunInboundEmail, verifyMailgunSignature } from '@ai-concierge/channels';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  releaseIdempotencyKeyClaim,
  PrismaAuditWriter,
  type Channel,
} from '@ai-concierge/db';
import { AppError } from '@ai-concierge/domain';
import { emailInboundAckResponseSchema } from '@ai-concierge/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppContext } from '../../context.js';
import { flagUnexpectedPiiInOutboundText } from '../../lib/dlp.js';
import { handleInboundTurn, recordOutboundReply } from '../../services/conversationTurnService.js';

const EMAIL_CHANNEL: Channel = 'EMAIL';

/**
 * One inbound email, end to end and automatically — the exact same
 * `handleInboundTurn` (Steps 1-4, the automatic Steps 5-8 chain, journey and
 * CRM sync, Gemini-worded grounded reply) as WhatsApp, just over the Email
 * channel. Idempotency mirrors WhatsApp's own claim-before-work discipline:
 * Mailgun retries an inbound-webhook delivery that doesn't 200 fast enough,
 * so the key is claimed atomically before any work starts, not
 * checked-then-saved at the end.
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
    const turn = await handleInboundTurn(ctx, {
      channel: EMAIL_CHANNEL,
      customerRef: inbound.from,
      body: inbound.body,
      requestId,
    });
    const replyText = turn.reply.text;

    await flagUnexpectedPiiInOutboundText(
      { prisma: ctx.prisma, logger: ctx.logger },
      { tenantId: ctx.config.DEFAULT_TENANT_ID, channel: EMAIL_CHANNEL, text: replyText },
    );

    const replySubject = inbound.subject.trim().toLowerCase().startsWith('re:')
      ? inbound.subject
      : `Re: ${inbound.subject || 'Your rental enquiry'}`;
    const sendResult = await ctx.emailProvider.sendEmail(inbound.from, replySubject, replyText);
    if (sendResult.status === 'SENT') {
      await recordOutboundReply(ctx, {
        conversationId: turn.conversationId,
        text: replyText,
        source: turn.reply.source === 'AI_GENERATED' ? 'AI_GENERATED' : 'TEMPLATE',
        stage: turn.reply.stage,
      });
    }

    const auditWriter = new PrismaAuditWriter(ctx.prisma);
    await auditWriter.record({
      tenantId: ctx.config.DEFAULT_TENANT_ID,
      actor: 'channel:email',
      action: 'email.reply_sent',
      entityType: 'Conversation',
      entityId: turn.conversationId,
      after: {
        sendStatus: sendResult.status,
        missingInfoStatus: turn.missingInfoStatus,
        journeyProgress: turn.progress.stage,
        replySource: turn.reply.source,
      },
      requestId,
    });

    await completeIdempotencyKey(ctx.prisma, idempotencyKey, 200, {
      conversationId: turn.conversationId,
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
