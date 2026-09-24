import { AppError, type AuthContext } from '@ai-concierge/domain';
import { verifyAccessToken, InvalidAccessTokenError } from '@ai-concierge/security/authn';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isSessionFamilyRevoked } from '../lib/sessionRevocation.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/**
 * Verifies the `Authorization: Bearer <accessToken>` header and attaches
 * `request.auth`. Also checks the Redis session-family revocation set — a
 * still-unexpired JWT from a revoked family (an operator's "revoke this
 * session" response, or reuse-detected token-theft containment) is rejected
 * immediately rather than waiting out its own `exp` (see
 * lib/sessionRevocation.ts). Register as a route `preHandler`, not globally
 * — most of this API's existing routes are deliberately unauthenticated
 * customer-journey intake (see docs/PHASE-6.md §3).
 */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new AppError('UNAUTHORIZED', 'Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length);

  let claims;
  try {
    claims = await verifyAccessToken(token, request.server.ctx.config.JWT_SIGNING_SECRET);
  } catch (error) {
    if (error instanceof InvalidAccessTokenError) {
      throw new AppError('UNAUTHORIZED', 'Invalid or expired access token');
    }
    throw error;
  }

  if (await isSessionFamilyRevoked(request.server.ctx.redis, claims.jti)) {
    throw new AppError('UNAUTHORIZED', 'This session has been revoked');
  }

  request.auth = {
    tenantId: claims.tid,
    userId: claims.sub,
    role: claims.role,
    sessionId: claims.jti,
  };
}
