import { z } from 'zod';
import { tenantIdSchema } from './tenant.js';

/**
 * Every mutation writes one of these, in the same transaction as the
 * mutation itself. `before`/`after` hold only field-level diffs the caller
 * builds explicitly — never a raw entity dump — so audit rows can't become
 * an accidental PII sink.
 */
export const auditEventSchema = z.object({
  tenantId: tenantIdSchema,
  actor: z.string().min(1).max(200),
  action: z.string().min(1).max(200),
  entityType: z.string().min(1).max(100),
  entityId: z.string().min(1).max(200),
  before: z.record(z.string(), z.unknown()).optional(),
  after: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string().min(1).max(200).optional(),
  ip: z.string().max(64).optional(),
});

export type AuditEventInput = z.infer<typeof auditEventSchema>;

/** Implemented by @ai-concierge/db; kept as an interface so services stay storage-agnostic. */
export interface AuditWriter {
  record(event: AuditEventInput): Promise<void>;
}
