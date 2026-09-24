import { ROLE_PERMISSIONS, type AuthContext, type PermissionValue } from '@ai-concierge/domain';

export interface ResourceAttributes {
  tenantId: string;
}

export type AuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: 'CROSS_TENANT' | 'MISSING_PERMISSION' };

/**
 * RBAC + ABAC in one function, per MASTER-PLAN.md §1's "AuthZ: RBAC + ABAC
 * policy engine (tenant, ownership, journey state, tier)". The tenant-match
 * check runs first and unconditionally — a role can never be granted enough
 * permission to see across tenants, so a coding mistake that requests the
 * wrong permission can't accidentally leak cross-tenant data. Ownership and
 * journey-state attributes extend this the same way once a resource that
 * needs them exists (today, only self-profile access needs an ownership
 * rule — see `isSelf`).
 */
export function authorize(
  auth: AuthContext,
  permission: PermissionValue,
  resource: ResourceAttributes,
): AuthorizationDecision {
  if (resource.tenantId !== auth.tenantId) {
    return { allowed: false, reason: 'CROSS_TENANT' };
  }
  if (!ROLE_PERMISSIONS[auth.role].includes(permission)) {
    return { allowed: false, reason: 'MISSING_PERMISSION' };
  }
  return { allowed: true };
}

/** A user may always read/update their own profile regardless of role — GET/PATCH /v1/auth/me. */
export function isSelf(auth: AuthContext, targetUserId: string): boolean {
  return auth.userId === targetUserId;
}
