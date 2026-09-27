import {
  MAX_VEHICLE_PHOTO_BYTES,
  createVehicleBodySchema,
  deleteVehiclePhotoResponseSchema,
  fleetVehicleResponseSchema,
  updateVehicleBodySchema,
  uploadVehiclePhotoQuerySchema,
  vehicleIdParamsSchema,
  vehiclePhotoIdParamsSchema,
  vehiclePhotoResponseSchema,
} from '@ai-concierge/contracts';
import { AppError, Permission } from '@ai-concierge/domain';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authenticate } from '../../plugins/auth.js';
import { requirePermission } from '../../lib/authz.js';
import {
  addVehiclePhoto,
  createFleetVehicle,
  removeVehiclePhoto,
  updateFleetVehicle,
  type FleetActor,
  type FleetServiceDeps,
} from '../../services/fleetService.js';

/**
 * Fleet management for the dashboard: add a car, edit it, and manage its
 * photos. All writes need `fleet:write` (ADMIN and MANAGER). A photo is sent
 * as the raw image body (`Content-Type: image/jpeg|png|webp`) — no multipart
 * parser — and is verified from its bytes, not from the header.
 */
export const fleetRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = (): FleetServiceDeps => ({
    prisma: app.ctx.prisma,
    storage: app.ctx.mediaStorage,
    publicBaseUrl: app.ctx.config.API_PUBLIC_URL,
  });
  const actorOf = (request: { auth?: { tenantId: string; userId: string }; id: string }) => {
    const auth = request.auth!;
    return { tenantId: auth.tenantId, userId: auth.userId, requestId: request.id } as FleetActor;
  };

  // Raw image bodies, capped at the photo limit (the global JSON limit is far smaller).
  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/webp'],
    { parseAs: 'buffer', bodyLimit: MAX_VEHICLE_PHOTO_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post(
    '/v1/fleet/vehicles',
    {
      preHandler: [authenticate, requirePermission(Permission.FLEET_WRITE)],
      schema: {
        tags: ['admin'],
        body: createVehicleBodySchema,
        response: { 201: fleetVehicleResponseSchema },
      },
    },
    async (request, reply) => {
      const vehicle = await createFleetVehicle(deps(), actorOf(request), request.body);
      reply.status(201).send({ vehicle });
    },
  );

  app.post(
    '/v1/fleet/vehicles/:vehicleId',
    {
      preHandler: [authenticate, requirePermission(Permission.FLEET_WRITE)],
      schema: {
        tags: ['admin'],
        params: vehicleIdParamsSchema,
        body: updateVehicleBodySchema,
        response: { 200: fleetVehicleResponseSchema },
      },
    },
    async (request, reply) => {
      const vehicle = await updateFleetVehicle(
        deps(),
        actorOf(request),
        request.params.vehicleId,
        request.body,
      );
      reply.status(200).send({ vehicle });
    },
  );

  app.post(
    '/v1/fleet/vehicles/:vehicleId/photos',
    {
      preHandler: [authenticate, requirePermission(Permission.FLEET_WRITE)],
      schema: {
        tags: ['admin'],
        params: vehicleIdParamsSchema,
        querystring: uploadVehiclePhotoQuerySchema,
        response: { 201: vehiclePhotoResponseSchema },
      },
    },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Send the photo as the request body with Content-Type image/jpeg, image/png or image/webp',
        );
      }
      const photo = await addVehiclePhoto(deps(), actorOf(request), {
        vehicleId: request.params.vehicleId,
        bytes: request.body,
        caption: request.query.caption,
      });
      reply.status(201).send({ photo });
    },
  );

  // POST (not DELETE): the API's CORS policy only allows GET/POST.
  app.post(
    '/v1/fleet/photos/:photoId/delete',
    {
      preHandler: [authenticate, requirePermission(Permission.FLEET_WRITE)],
      schema: {
        tags: ['admin'],
        params: vehiclePhotoIdParamsSchema,
        response: { 200: deleteVehiclePhotoResponseSchema },
      },
    },
    async (request, reply) => {
      await removeVehiclePhoto(deps(), actorOf(request), request.params.photoId);
      reply.status(200).send({ deleted: true });
    },
  );
};
