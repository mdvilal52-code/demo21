import { z } from 'zod';
import { vehicleDeterminationResultSchema } from '@ai-concierge/domain';

export const determineVehicleParamsSchema = z.object({
  conversationId: z.string().uuid(),
});
export type DetermineVehicleParams = z.infer<typeof determineVehicleParamsSchema>;

export const determineVehicleResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  determination: vehicleDeterminationResultSchema,
});
export type DetermineVehicleResponse = z.infer<typeof determineVehicleResponseSchema>;
