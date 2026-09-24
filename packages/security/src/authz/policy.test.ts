import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Permission, ROLE_PERMISSIONS, UserRole, type AuthContext } from '@ai-concierge/domain';
import { authorize, isSelf } from './policy.js';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    tenantId: TENANT_A,
    userId: randomUUID(),
    role: UserRole.ADMIN,
    sessionId: randomUUID(),
    ...overrides,
  };
}

describe('authorize — RBAC + ABAC', () => {
  it('denies cross-tenant access before checking permission, regardless of role', () => {
    const decision = authorize(auth({ role: UserRole.ADMIN }), Permission.AUDIT_EVENT_READ, {
      tenantId: TENANT_B,
    });
    expect(decision).toEqual({ allowed: false, reason: 'CROSS_TENANT' });
  });

  it('allows same-tenant access when the role carries the permission', () => {
    const decision = authorize(auth({ role: UserRole.SECURITY }), Permission.AUDIT_EVENT_READ, {
      tenantId: TENANT_A,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('denies same-tenant access when the role lacks the permission', () => {
    const decision = authorize(auth({ role: UserRole.OPS_AGENT }), Permission.SECURITY_EVENT_RESPOND, {
      tenantId: TENANT_A,
    });
    expect(decision).toEqual({ allowed: false, reason: 'MISSING_PERMISSION' });
  });

  it('full authz matrix: every role x every permission has a defined, expected outcome', () => {
    const matrix: Array<[keyof typeof UserRole, keyof typeof Permission, boolean]> = [
      ['ADMIN', 'AUDIT_EVENT_READ', true],
      ['ADMIN', 'SECURITY_EVENT_RESPOND', true],
      ['ADMIN', 'USER_LOCK', true],
      ['SECURITY', 'SECURITY_EVENT_RESPOND', true],
      ['SECURITY', 'USER_LOCK', true],
      ['MANAGER', 'AUDIT_EVENT_READ', true],
      ['MANAGER', 'SECURITY_EVENT_RESPOND', false],
      ['MANAGER', 'USER_LOCK', false],
      ['OPS_AGENT', 'USER_READ', true],
      ['OPS_AGENT', 'AUDIT_EVENT_READ', false],
      ['OPS_AGENT', 'SECURITY_EVENT_READ', false],
      ['OPS_AGENT', 'USER_LOCK', false],
    ];

    for (const [role, permission, expected] of matrix) {
      const decision = authorize(auth({ role: UserRole[role] }), Permission[permission], {
        tenantId: TENANT_A,
      });
      expect(decision.allowed, `${role} x ${permission}`).toBe(expected);
    }
  });

  it('ADMIN is always a superset of every other role', () => {
    for (const permission of Object.values(Permission)) {
      for (const role of [UserRole.SECURITY, UserRole.MANAGER, UserRole.OPS_AGENT]) {
        if (ROLE_PERMISSIONS[role].includes(permission)) {
          expect(ROLE_PERMISSIONS[UserRole.ADMIN]).toContain(permission);
        }
      }
    }
  });
});

describe('isSelf', () => {
  it('is true only when the authenticated user matches the target', () => {
    const userId = randomUUID();
    expect(isSelf(auth({ userId }), userId)).toBe(true);
    expect(isSelf(auth({ userId }), randomUUID())).toBe(false);
  });
});
