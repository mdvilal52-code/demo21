import { z } from 'zod';
import { tenantIdSchema } from './tenant.js';

/**
 * Human staff accounts. Roles mirror MASTER-PLAN.md §4's escalation tiers —
 * ADMIN is a superset, MANAGER=T3, OPS_AGENT=T2, SECURITY=T4. T1 is the AI
 * itself, never a human role. Kept in sync by hand with the Prisma `UserRole`
 * enum (packages/db/prisma/schema.prisma), same convention as every other
 * domain enum in this package (see vehicle.ts, temporal.ts).
 */
export const UserRole = {
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  OPS_AGENT: 'OPS_AGENT',
  SECURITY: 'SECURITY',
} as const;

export const userRoleSchema = z.enum([
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.OPS_AGENT,
  UserRole.SECURITY,
]);
export type UserRoleValue = z.infer<typeof userRoleSchema>;

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const;

export const userStatusSchema = z.enum([UserStatus.ACTIVE, UserStatus.SUSPENDED]);
export type UserStatusValue = z.infer<typeof userStatusSchema>;

export const SecurityEventType = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILURE: 'LOGIN_FAILURE',
  MFA_ENROLLED: 'MFA_ENROLLED',
  MFA_FAILURE: 'MFA_FAILURE',
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CROSS_TENANT_ATTEMPT: 'CROSS_TENANT_ATTEMPT',
  SESSION_REVOKED: 'SESSION_REVOKED',
  ANOMALY_LOGIN_VELOCITY: 'ANOMALY_LOGIN_VELOCITY',
  ANOMALY_MASS_EXPORT: 'ANOMALY_MASS_EXPORT',
  DLP_OUTBOUND_PII_DETECTED: 'DLP_OUTBOUND_PII_DETECTED',
} as const;

export const securityEventTypeSchema = z.enum([
  SecurityEventType.LOGIN_SUCCESS,
  SecurityEventType.LOGIN_FAILURE,
  SecurityEventType.MFA_ENROLLED,
  SecurityEventType.MFA_FAILURE,
  SecurityEventType.TOKEN_REUSE_DETECTED,
  SecurityEventType.ACCOUNT_LOCKED,
  SecurityEventType.PERMISSION_DENIED,
  SecurityEventType.CROSS_TENANT_ATTEMPT,
  SecurityEventType.SESSION_REVOKED,
  SecurityEventType.ANOMALY_LOGIN_VELOCITY,
  SecurityEventType.ANOMALY_MASS_EXPORT,
  SecurityEventType.DLP_OUTBOUND_PII_DETECTED,
]);
export type SecurityEventTypeValue = z.infer<typeof securityEventTypeSchema>;

export const SecuritySeverity = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
} as const;

export const securitySeveritySchema = z.enum([
  SecuritySeverity.INFO,
  SecuritySeverity.WARNING,
  SecuritySeverity.CRITICAL,
]);
export type SecuritySeverityValue = z.infer<typeof securitySeveritySchema>;

/**
 * Fine-grained permissions the RBAC/ABAC policy engine
 * (@ai-concierge/security's authorize()) checks against. Deliberately scoped
 * to resources that are real today (audit/security events, user management)
 * rather than padded with permissions for screens/entities that don't exist
 * yet (booking, pricing, …) — see docs/PHASE-6.md §3.
 */
export const Permission = {
  AUDIT_EVENT_READ: 'audit_event:read',
  SECURITY_EVENT_READ: 'security_event:read',
  SECURITY_EVENT_RESPOND: 'security_event:respond',
  USER_READ: 'user:read',
  USER_LOCK: 'user:lock',
  USER_UNLOCK: 'user:unlock',
} as const;

export const permissionSchema = z.enum([
  Permission.AUDIT_EVENT_READ,
  Permission.SECURITY_EVENT_READ,
  Permission.SECURITY_EVENT_RESPOND,
  Permission.USER_READ,
  Permission.USER_LOCK,
  Permission.USER_UNLOCK,
]);
export type PermissionValue = z.infer<typeof permissionSchema>;

/**
 * RBAC role -> permission matrix. ADMIN is a superset of every other role by
 * construction (spread, not duplicated by hand) so adding a permission to a
 * lower tier never has to be remembered for ADMIN separately.
 */
const SECURITY_PERMISSIONS: PermissionValue[] = [
  Permission.AUDIT_EVENT_READ,
  Permission.SECURITY_EVENT_READ,
  Permission.SECURITY_EVENT_RESPOND,
  Permission.USER_READ,
  Permission.USER_LOCK,
  Permission.USER_UNLOCK,
];
const MANAGER_PERMISSIONS: PermissionValue[] = [
  Permission.AUDIT_EVENT_READ,
  Permission.SECURITY_EVENT_READ,
  Permission.USER_READ,
];
const OPS_AGENT_PERMISSIONS: PermissionValue[] = [Permission.USER_READ];

export const ROLE_PERMISSIONS: Record<UserRoleValue, PermissionValue[]> = {
  [UserRole.SECURITY]: SECURITY_PERMISSIONS,
  [UserRole.MANAGER]: MANAGER_PERMISSIONS,
  [UserRole.OPS_AGENT]: OPS_AGENT_PERMISSIONS,
  [UserRole.ADMIN]: [
    ...new Set([...SECURITY_PERMISSIONS, ...MANAGER_PERMISSIONS, ...OPS_AGENT_PERMISSIONS]),
  ],
};

/** Carried on every authenticated request — the ABAC subject. */
export interface AuthContext {
  tenantId: string;
  userId: string;
  role: UserRoleValue;
  sessionId: string;
}

export const accessTokenClaimsSchema = z.object({
  sub: z.string().uuid(), // userId
  tid: tenantIdSchema, // tenantId
  role: userRoleSchema,
  jti: z.string().uuid(), // refresh-token familyId this access token was issued alongside
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

/** Safe, public shape of a User — never the password hash or MFA secret. */
export const authenticatedUserSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  email: z.string().email(),
  role: userRoleSchema,
  status: userStatusSchema,
  mfaEnabled: z.boolean(),
});
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;
