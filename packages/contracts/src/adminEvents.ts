import { z } from 'zod';
import { securityEventTypeSchema, securitySeveritySchema } from '@ai-concierge/domain';

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(25),
  cursor: z.string().uuid().optional(),
});

export const auditEventItemSchema = z.object({
  id: z.string().uuid(),
  actor: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  requestId: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
});

export const listAuditEventsResponseSchema = z.object({
  items: z.array(auditEventItemSchema),
  nextCursor: z.string().uuid().nullable(),
});
export type ListAuditEventsResponse = z.infer<typeof listAuditEventsResponseSchema>;

export const listSecurityEventsQuerySchema = listQuerySchema.extend({
  severity: securitySeveritySchema.optional(),
});

export const securityEventItemSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  type: securityEventTypeSchema,
  severity: securitySeveritySchema,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const listSecurityEventsResponseSchema = z.object({
  items: z.array(securityEventItemSchema),
  nextCursor: z.string().uuid().nullable(),
});
export type ListSecurityEventsResponse = z.infer<typeof listSecurityEventsResponseSchema>;
