import { z } from 'zod';
import { dateLocationExtractionResultSchema } from '@ai-concierge/domain';

export const extractDatesLocationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});
export type ExtractDatesLocationParams = z.infer<typeof extractDatesLocationParamsSchema>;

export const extractDatesLocationResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  extraction: dateLocationExtractionResultSchema,
});
export type ExtractDatesLocationResponse = z.infer<typeof extractDatesLocationResponseSchema>;
