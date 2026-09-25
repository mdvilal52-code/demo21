import { z } from 'zod';
import { quoteSelectionsSchema, quoteSnapshotSchema } from '@ai-concierge/domain';

export const createQuoteParamsSchema = z.object({
  conversationId: z.string().uuid(),
});
export type CreateQuoteParams = z.infer<typeof createQuoteParamsSchema>;

/**
 * `quoteSelectionsSchema` is already `.strict()` (defined once in
 * `packages/domain/src/quote.ts`) — no money field anywhere in it. That is
 * the entire price-manipulation-prevention boundary: a client can select
 * *which* extras/insurance/delivery/discount code, never *how much* they
 * cost. Every field is optional with a default, so an empty `{}` body (the
 * common case: no extras) is valid.
 */
export const createQuoteBodySchema = quoteSelectionsSchema;
export type CreateQuoteBody = z.infer<typeof createQuoteBodySchema>;

export const createQuoteResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  quote: quoteSnapshotSchema,
});
export type CreateQuoteResponse = z.infer<typeof createQuoteResponseSchema>;

export const getQuoteParamsSchema = createQuoteParamsSchema;
export type GetQuoteParams = z.infer<typeof getQuoteParamsSchema>;

export const getQuoteResponseSchema = createQuoteResponseSchema;
export type GetQuoteResponse = z.infer<typeof getQuoteResponseSchema>;
