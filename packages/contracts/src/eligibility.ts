import { z } from 'zod';
import {
  driverInputSchema,
  eligibilityCustomerInputSchema,
  eligibilityDecisionResultSchema,
} from '@ai-concierge/domain';

export const checkEligibilityParamsSchema = z.object({
  conversationId: z.string().uuid(),
});
export type CheckEligibilityParams = z.infer<typeof checkEligibilityParamsSchema>;

/**
 * `.strict()` deliberately rejects any unrecognized key — including a
 * client attempting to smuggle in a `status`/`policyId`/`decision` field to
 * influence the outcome directly. The decision is always computed
 * server-side from the tenant's own active policy; nothing here lets a
 * caller select or override it.
 */
export const checkEligibilityBodySchema = z
  .object({
    customer: eligibilityCustomerInputSchema,
    additionalDrivers: z.array(driverInputSchema).max(10).default([]),
  })
  .strict();
export type CheckEligibilityBody = z.infer<typeof checkEligibilityBodySchema>;

export const checkEligibilityResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  decision: eligibilityDecisionResultSchema,
});
export type CheckEligibilityResponse = z.infer<typeof checkEligibilityResponseSchema>;
