import {
  authTokenPairSchema,
  loginRequestSchema,
  logoutRequestSchema,
  mfaEnrollResponseSchema,
  mfaVerifyRequestSchema,
  mfaVerifyResponseSchema,
  refreshRequestSchema,
} from '@ai-concierge/contracts';
import { authenticatedUserSchema } from '@ai-concierge/domain';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authenticate } from '../../plugins/auth.js';
import {
  enrollMfa,
  getMe,
  login,
  logout,
  refresh,
  verifyMfaEnrollment,
  type AuthServiceDeps,
} from '../../services/authService.js';

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
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
    '/v1/auth/login',
    {
      config: { rateLimit: { max: app.ctx.config.AUTH_RATE_LIMIT_MAX, timeWindow: app.ctx.config.AUTH_RATE_LIMIT_WINDOW_MS } },
      schema: { tags: ['auth'], body: loginRequestSchema, response: { 200: authTokenPairSchema } },
    },
    async (request, reply) => {
      const result = await login(deps(), {
        tenantId: app.ctx.config.DEFAULT_TENANT_ID,
        email: request.body.email,
        password: request.body.password,
        ...(request.body.mfaCode ? { mfaCode: request.body.mfaCode } : {}),
        requestId: request.id,
        ip: request.ip,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      });
      reply.status(200).send(result);
    },
  );

  app.post(
    '/v1/auth/refresh',
    {
      config: { rateLimit: { max: app.ctx.config.AUTH_RATE_LIMIT_MAX, timeWindow: app.ctx.config.AUTH_RATE_LIMIT_WINDOW_MS } },
      schema: { tags: ['auth'], body: refreshRequestSchema, response: { 200: authTokenPairSchema } },
    },
    async (request, reply) => {
      const result = await refresh(deps(), {
        refreshToken: request.body.refreshToken,
        ip: request.ip,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      });
      reply.status(200).send(result);
    },
  );

  app.post(
    '/v1/auth/logout',
    { schema: { tags: ['auth'], body: logoutRequestSchema } },
    async (request, reply) => {
      await logout(deps(), { refreshToken: request.body.refreshToken });
      reply.status(204).send();
    },
  );

  app.get(
    '/v1/auth/me',
    { preHandler: [authenticate], schema: { tags: ['auth'], response: { 200: authenticatedUserSchema } } },
    async (request, reply) => {
      const user = await getMe(deps(), request.auth!);
      reply.status(200).send(user);
    },
  );

  app.post(
    '/v1/auth/mfa/enroll',
    {
      preHandler: [authenticate],
      schema: { tags: ['auth'], response: { 200: mfaEnrollResponseSchema } },
    },
    async (request, reply) => {
      const result = await enrollMfa(deps(), request.auth!);
      reply.status(200).send(result);
    },
  );

  app.post(
    '/v1/auth/mfa/verify',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['auth'],
        body: mfaVerifyRequestSchema,
        response: { 200: mfaVerifyResponseSchema },
      },
    },
    async (request, reply) => {
      await verifyMfaEnrollment(deps(), request.auth!, request.body.code);
      reply.status(200).send({ mfaEnabled: true });
    },
  );
};
