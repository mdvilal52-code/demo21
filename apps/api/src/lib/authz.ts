import { AppError, type PermissionValue } from '@ai-concierge/domain';
import { authorize } from '@ai-concierge/security';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * A route `preHandler` factory — pairs with `authenticate` (plugins/auth.ts),
 * which must run first to populate `request.auth`. Checks RBAC+ABAC via
 * `authorize()`; the resource's tenant is always `request.auth.tenantId`
 * here because every admin route this phase adds only ever lists the
 * caller's own tenant's rows — a route that fetches one specific resource
 * by id would instead pass that resource's real tenantId once it exists.
 */
export function requirePermission(permission: PermissionValue) {
  return async function requirePermissionPreHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    if (!request.auth) {
      throw new AppError('UNAUTHORIZED', 'Authentication is required before authorization');
    }
    const decision = authorize(request.auth, permission, { tenantId: request.auth.tenantId });
    if (!decision.allowed) {
      throw new AppError('FORBIDDEN', `Missing required permission: ${permission}`, {
        details: { reason: decision.reason },
      });
    }
  };
}
