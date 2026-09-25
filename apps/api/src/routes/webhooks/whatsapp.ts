import { AppError } from '@ai-concierge/domain';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { verifyMetaWebhookSignature } from '../../lib/whatsappSignature.js';
import {
  extractInboundMessages,
  whatsappWebhookPayloadSchema,
} from '../../lib/whatsappWebhookPayload.js';
import { handleInboundWhatsAppMessage } from '../../services/whatsappService.js';

const verifyQuerySchema = z
  .object({
    'hub.mode': z.string().optional(),
    'hub.verify_token': z.string().optional(),
    'hub.challenge': z.string().optional(),
  })
  .passthrough();

/**
 * Meta Cloud API webhook. Registered as its own encapsulated plugin so the
 * raw-body content-type parser below is scoped to just these two routes —
 * Fastify content-type parsers are per-plugin-context, so every other route
 * (enquiries, temporal, vehicle, missing-info, health) keeps the app's
 * normal parsed-JSON body untouched.
 */
export const whatsappWebhookRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.get(
    '/webhooks/whatsapp',
    {
      // Meta calls this from a shared IP pool serving every customer's
      // messages, not one IP per customer — the app-wide per-IP rate limit
      // is the wrong shape here and would throttle the whole business.
      config: { rateLimit: false },
      schema: { tags: ['webhooks'], querystring: verifyQuerySchema },
    },
    async (request, reply) => {
      const {
        'hub.mode': mode,
        'hub.verify_token': token,
        'hub.challenge': challenge,
      } = request.query;
      const expectedToken = app.ctx.config.WHATSAPP_VERIFY_TOKEN;

      if (!expectedToken || mode !== 'subscribe' || !challenge || token !== expectedToken) {
        request.log.warn('WhatsApp webhook verification failed');
        throw new AppError('FORBIDDEN', 'Webhook verification failed');
      }

      reply.type('text/plain').send(challenge);
    },
  );

  app.post('/webhooks/whatsapp', { config: { rateLimit: false } }, async (request, reply) => {
    const appSecret = app.ctx.config.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      throw new AppError('NOT_CONFIGURED', 'WhatsApp webhook is not configured');
    }

    const rawBody = (request.body as Buffer | undefined) ?? Buffer.alloc(0);
    const rawBodyText = rawBody.toString('utf8');
    const signatureHeader = request.headers['x-hub-signature-256'];
    if (!verifyMetaWebhookSignature(rawBodyText, signatureHeader, appSecret)) {
      request.log.warn('WhatsApp webhook signature verification failed');
      throw new AppError('UNAUTHORIZED', 'Invalid webhook signature');
    }

    let json: unknown;
    try {
      json = rawBodyText.length > 0 ? JSON.parse(rawBodyText) : {};
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Malformed JSON payload');
    }

    const parsed = whatsappWebhookPayloadSchema.safeParse(json);
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', 'Malformed WhatsApp webhook payload');
    }

    const messages = extractInboundMessages(parsed.data);
    for (const message of messages) {
      await handleInboundWhatsAppMessage(
        {
          prisma: app.ctx.prisma,
          intentEngine: app.ctx.intentEngine,
          postEnquiryQueue: app.ctx.postEnquiryQueue,
          dateLocationOrchestrator: app.ctx.dateLocationOrchestrator,
          vehicleOrchestrator: app.ctx.vehicleOrchestrator,
          missingInfoOrchestrator: app.ctx.missingInfoOrchestrator,
          whatsappClient: app.ctx.whatsappClient,
          aiProvider: app.ctx.aiProvider,
          logger: request.log,
        },
        { tenantId: app.ctx.config.DEFAULT_TENANT_ID, requestId: request.id, message },
      );
    }

    reply.status(200).send({ received: true });
  });
};
