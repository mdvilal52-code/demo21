import { z } from 'zod';

/**
 * A car photo the concierge attached to a reply (the customer asked to see a
 * vehicle). Stored on the outbound message as JSON and resolved to a public
 * URL only when shown/sent — the stored form carries ids, never a URL.
 */
export const outboundAttachmentSchema = z.object({
  photoId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  caption: z.string().max(200),
});
export type OutboundAttachment = z.infer<typeof outboundAttachmentSchema>;
