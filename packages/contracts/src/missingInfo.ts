import { z } from 'zod';
import { missingInfoResultSchema } from '@ai-concierge/domain';

export const checkMissingInfoParamsSchema = z.object({
  conversationId: z.string().uuid(),
});
export type CheckMissingInfoParams = z.infer<typeof checkMissingInfoParamsSchema>;

export const checkMissingInfoResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  missingInfo: missingInfoResultSchema,
});
export type CheckMissingInfoResponse = z.infer<typeof checkMissingInfoResponseSchema>;
