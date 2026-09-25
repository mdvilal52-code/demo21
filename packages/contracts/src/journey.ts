import { z } from 'zod';
import {
  escalationCaseSchema,
  escalationStatusSchema,
  journeySchema,
  journeyTransitionSchema,
  resolveEscalationCaseInputSchema,
} from '@ai-concierge/domain';

export const getJourneyParamsSchema = z.object({ conversationId: z.string().uuid() });
export type GetJourneyParams = z.infer<typeof getJourneyParamsSchema>;

export const getJourneyResponseSchema = z.object({
  journey: journeySchema,
  transitions: z.array(journeyTransitionSchema),
});
export type GetJourneyResponse = z.infer<typeof getJourneyResponseSchema>;

export const listEscalationsQuerySchema = z.object({
  status: escalationStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type ListEscalationsQuery = z.infer<typeof listEscalationsQuerySchema>;

export const listEscalationsResponseSchema = z.object({
  items: z.array(escalationCaseSchema),
});
export type ListEscalationsResponse = z.infer<typeof listEscalationsResponseSchema>;

export const escalationCaseParamsSchema = z.object({ escalationCaseId: z.string().uuid() });
export type EscalationCaseParams = z.infer<typeof escalationCaseParamsSchema>;

export const escalationCaseResponseSchema = z.object({ escalationCase: escalationCaseSchema });
export type EscalationCaseResponse = z.infer<typeof escalationCaseResponseSchema>;

export const resolveEscalationBodySchema = resolveEscalationCaseInputSchema.strict();
export type ResolveEscalationBody = z.infer<typeof resolveEscalationBodySchema>;
