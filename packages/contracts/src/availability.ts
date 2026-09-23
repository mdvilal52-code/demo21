import { z } from 'zod';
import { availabilityCheckResultSchema } from '@ai-concierge/domain';

export const checkAvailabilityParamsSchema = z.object({
  conversationId: z.string().uuid(),
});
export type CheckAvailabilityParams = z.infer<typeof checkAvailabilityParamsSchema>;

export const checkAvailabilityResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  availability: availabilityCheckResultSchema,
});
export type CheckAvailabilityResponse = z.infer<typeof checkAvailabilityResponseSchema>;
