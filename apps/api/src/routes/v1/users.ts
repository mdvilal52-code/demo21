import { Permission } from '@ai-concierge/domain';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authenticate } from '../../plugins/auth.js';
import { requirePermission } from '../../lib/authz.js';
import { setUserLock, type AuthServiceDeps } from '../../services/authService.js';

const userIdParamsSchema = z.object({ userId: z.string().uuid() });

/** The manual half of "automatic restricted response" (docs/SECURITY-MODEL.md): an operator containing a suspected-compromised account. */
export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  function deps(): AuthServiceDeps {
    return {
      prisma: app.ctx.prisma,
      redis: app.ctx.redis,
      jwtSigningSecret: app.ctx.config.JWT_SIGNING_SECRET,
      mfaEncryptionKey: app.ctx.config.MFA_ENCRYPTION_KEY,
      tokenIssuer: app.ctx.config.AUTH_TOKEN_ISSUER,
    };
  }

  app.post(
    '/v1/users/:userId/lock',
    {
      preHandler: [authenticate, requirePermission(Permission.USER_LOCK)],
      schema: { tags: ['admin'], params: userIdParamsSchema },
    },
    async (request, reply) => {
      await setUserLock(deps(), {
        tenantId: request.auth!.tenantId,
        targetUserId: request.params.userId,
        actorUserId: request.auth!.userId,
        requestId: request.id,
        locked: true,
      });
      reply.status(204).send();
    },
  );

  app.post(
    '/v1/users/:userId/unlock',
    {
      preHandler: [authenticate, requirePermission(Permission.USER_UNLOCK)],
      schema: { tags: ['admin'], params: userIdParamsSchema },
    },
    async (request, reply) => {
      await setUserLock(deps(), {
        tenantId: request.auth!.tenantId,
        targetUserId: request.params.userId,
        actorUserId: request.auth!.userId,
        requestId: request.id,
        locked: false,
      });
      reply.status(204).send();
    },
  );
};
