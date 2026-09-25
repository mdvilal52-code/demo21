import { z } from 'zod';
import { recommendAlternativesResultSchema } from '@ai-concierge/domain';

export const recommendAlternativesParamsSchema = z.object({
  conversationId: z.string().uuid(),
});
export type RecommendAlternativesParams = z.infer<typeof recommendAlternativesParamsSchema>;

export const recommendAlternativesResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  alternatives: recommendAlternativesResultSchema,
});
export type RecommendAlternativesResponse = z.infer<typeof recommendAlternativesResponseSchema>;
