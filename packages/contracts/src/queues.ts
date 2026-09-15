import { z } from 'zod';
import { tenantIdSchema } from '@ai-concierge/domain';

export const QUEUE_NAMES = {
  POST_ENQUIRY_PROCESSING: 'post-enquiry-processing',
} as const;

export const postEnquiryJobSchema = z.object({
  tenantId: tenantIdSchema,
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  requestId: z.string().min(1),
});
export type PostEnquiryJob = z.infer<typeof postEnquiryJobSchema>;
