import { z } from 'zod';

export const tenantIdSchema = z.string().uuid();
export type TenantId = z.infer<typeof tenantIdSchema>;

/**
 * Carried through every request and job. Repository functions take this
 * explicitly (never read an ambient global) and must filter every query by
 * `tenantId` — the app-level half of tenant isolation until Phase 2/6 add
 * database-level Row Level Security policies as the enforced backstop.
 */
export interface TenantContext {
  tenantId: TenantId;
}

export function requireTenantContext(context: TenantContext | undefined): TenantContext {
  if (!context?.tenantId) {
    throw new Error('Tenant context is required but was not provided');
  }
  return context;
}
