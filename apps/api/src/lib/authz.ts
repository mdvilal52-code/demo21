import {
  AppError,
  SecurityEventType,
  SecuritySeverity,
  type PermissionValue,
} from '@ai-concierge/domain';
import { authorize } from '@ai-concierge/security';
import { recordSecurityEvent, withTenantContext } from '@ai-concierge/db';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * A route `preHandler` factory — pairs with `authenticate` (plugins/auth.ts),
 * which must run first to populate `request.auth`. Checks RBAC+ABAC via
 * `authorize()`; the resource's tenant is always `request.auth.tenantId`
 * here because every admin route this phase adds only ever lists the
 * caller's own tenant's rows — a route that fetches one specific resource
 * by id would instead pass that resource's real tenantId once it exists.
 * A denial is itself a security signal (a valid session probing for access
 * it doesn't have), so it is recorded, not just rejected — the kill-chain
 * test's AuthZ-layer containment relies on this being visible in
 * `GET /v1/security-events`.
 */
export function requirePermission(permission: PermissionValue) {
  return async function requirePermissionPreHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    if (!request.auth) {
      throw new AppError('UNAUTHORIZED', 'Authentication is required before authorization');
    }
    const auth = request.auth;
    const decision = authorize(auth, permission, { tenantId: auth.tenantId });
    if (!decision.allowed) {
      await withTenantContext(request.server.ctx.prisma, auth.tenantId, (tx) =>
        recordSecurityEvent(tx, {
          tenantId: auth.tenantId,
          userId: auth.userId,
          type:
            decision.reason === 'CROSS_TENANT'
              ? SecurityEventType.CROSS_TENANT_ATTEMPT
              : SecurityEventType.PERMISSION_DENIED,
          severity: SecuritySeverity.WARNING,
          metadata: { permission, reason: decision.reason, path: request.url },
        }),
      );
      throw new AppError('FORBIDDEN', `Missing required permission: ${permission}`, {
        details: { reason: decision.reason },
      });
    }
  };
}
