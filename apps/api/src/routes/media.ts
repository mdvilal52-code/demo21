import { findVehiclePhoto } from '@ai-concierge/db';
import { AppError } from '@ai-concierge/domain';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/**
 * Public car photos. Anyone with the (unguessable UUID) URL can view the
 * image — that is the point: the website chat, WhatsApp and email all show
 * these to customers. Only images the dashboard uploaded are ever served,
 * always with the type the bytes were verified as at upload, `nosniff`, and a
 * CSP that forbids running anything, so a photo can never act as a page.
 */
export const mediaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/media/vehicles/:photoId',
    {
      config: { rateLimit: { max: 600, timeWindow: 60_000 } },
      schema: { tags: ['media'], params: z.object({ photoId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const photo = await findVehiclePhoto(
        app.ctx.prisma,
        app.ctx.config.DEFAULT_TENANT_ID,
        request.params.photoId,
      );
      if (!photo) throw new AppError('NOT_FOUND', 'Photo not found');
      const bytes = await app.ctx.mediaStorage.read(photo.storageKey);
      if (!bytes) throw new AppError('NOT_FOUND', 'Photo not found');

      reply
        .header('content-type', photo.contentType)
        .header('content-length', String(bytes.length))
        .header('cache-control', 'public, max-age=86400')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        // The site and emails load these from another origin.
        .header('cross-origin-resource-policy', 'cross-origin')
        .status(200)
        .send(bytes);
    },
  );
};
