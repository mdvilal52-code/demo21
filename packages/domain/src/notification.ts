import { z } from 'zod';

/**
 * Staff notification — how an `EscalationCase` (journey.ts) actually reaches
 * the assigned human worker in the real world, per the project brief: "AI
 * kaam nahi kar paye toh human worker ko [alert] kar sake." Deliberately its
 * own provider seam, distinct from the customer-facing channels
 * (`@ai-concierge/channels`): a worker is a `User` row (packages/domain's
 * `auth.ts`), never a `Conversation`/`customerRef`, and this never carries
 * booking content — only a short, deterministic pointer back to the
 * dashboard's Escalation Queue (never free-form AI text, same
 * "notifications are dumb, the dashboard is the source of truth" posture
 * `SecurityEvent`'s escalation surface already established in Phase 6).
 */
export const NotificationChannel = {
  SMS: 'SMS',
  EMAIL: 'EMAIL',
} as const;
export const notificationChannelSchema = z.enum([
  NotificationChannel.SMS,
  NotificationChannel.EMAIL,
]);
export type NotificationChannelValue = z.infer<typeof notificationChannelSchema>;

/**
 * Mirrors `WhatsAppProvider.sendTextMessage`'s own result-object convention
 * (packages/channels) — a failed or unconfigured send must never throw and
 * block the escalation itself from being created; the case still exists
 * and is visible on the dashboard regardless of whether the out-of-band
 * ping succeeded.
 */
export const NotificationSendStatus = {
  SENT: 'SENT',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  FAILED: 'FAILED',
} as const;
export const notificationSendStatusSchema = z.enum([
  NotificationSendStatus.SENT,
  NotificationSendStatus.NOT_CONFIGURED,
  NotificationSendStatus.FAILED,
]);
export type NotificationSendStatusValue = z.infer<typeof notificationSendStatusSchema>;

export const notificationSendResultSchema = z.object({
  channel: notificationChannelSchema,
  status: notificationSendStatusSchema,
  providerRef: z.string().nullable(),
  error: z.string().nullable(),
});
export type NotificationSendResult = z.infer<typeof notificationSendResultSchema>;
