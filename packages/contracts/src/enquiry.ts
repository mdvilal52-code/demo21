import { z } from 'zod';
import { channelSchema, intentResultSchema, messageContentSchema } from '@ai-concierge/domain';

export const createEnquiryRequestSchema = z.object({
  channel: channelSchema,
  customerRef: z
    .string()
    .trim()
    .min(1, 'customerRef is required')
    .max(200, 'customerRef cannot exceed 200 characters'),
  message: messageContentSchema,
});
export type CreateEnquiryRequest = z.infer<typeof createEnquiryRequestSchema>;

export const createEnquiryResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  intent: intentResultSchema,
});
export type CreateEnquiryResponse = z.infer<typeof createEnquiryResponseSchema>;

export const getConversationResponseSchema = z.object({
  conversationId: z.string().uuid(),
  channel: channelSchema,
  customerRef: z.string(),
  createdAt: z.string().datetime(),
  processedAt: z.string().datetime().nullable(),
  messages: z.array(
    z.object({
      id: z.string().uuid(),
      content: z.string(),
      createdAt: z.string().datetime(),
      intents: z.array(intentResultSchema),
    }),
  ),
});
export type GetConversationResponse = z.infer<typeof getConversationResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
