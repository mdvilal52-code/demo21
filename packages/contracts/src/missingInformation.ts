import { z } from 'zod';
import { missingInformationResultSchema } from '@ai-concierge/domain';

export const collectMissingInformationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});
export type CollectMissingInformationParams = z.infer<typeof collectMissingInformationParamsSchema>;

export const collectMissingInformationResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  result: missingInformationResultSchema,
});
export type CollectMissingInformationResponse = z.infer<
  typeof collectMissingInformationResponseSchema
>;
