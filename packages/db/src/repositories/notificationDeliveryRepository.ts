import { Prisma, type PrismaClient } from '@prisma/client';
import type { TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export const NotificationKind = {
  QUOTE_ISSUED: 'QUOTE_ISSUED',
  HANDOFF_ACK: 'HANDOFF_ACK',
} as const;
export type NotificationKindValue = (typeof NotificationKind)[keyof typeof NotificationKind];

export const NotificationDeliveryChannel = { EMAIL: 'EMAIL', SMS: 'SMS' } as const;
export type NotificationDeliveryChannelValue =
  (typeof NotificationDeliveryChannel)[keyof typeof NotificationDeliveryChannel];

export const NotificationDeliveryStatus = {
  SENT: 'SENT',
  FAILED: 'FAILED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
} as const;
export type NotificationDeliveryStatusValue =
  (typeof NotificationDeliveryStatus)[keyof typeof NotificationDeliveryStatus];

export interface NotificationDeliveryKey {
  tenantId: TenantId;
  kind: NotificationKindValue;
  subjectKey: string;
  channel: NotificationDeliveryChannelValue;
}

/** True when this exact notification already left successfully — the guard against emailing the same quote twice. */
export async function hasSentNotification(
  db: Executor,
  key: NotificationDeliveryKey,
): Promise<boolean> {
  const row = await db.notificationDelivery.findFirst({
    where: { ...key, status: NotificationDeliveryStatus.SENT },
    select: { id: true },
  });
  return row !== null;
}

/** True when any attempt (sent or not) was ever recorded for this notification. */
export async function hasNotificationAttempt(
  db: Executor,
  key: NotificationDeliveryKey,
): Promise<boolean> {
  const row = await db.notificationDelivery.findFirst({ where: key, select: { id: true } });
  return row !== null;
}

export interface RecordNotificationDeliveryInput extends NotificationDeliveryKey {
  conversationId: string | null;
  status: NotificationDeliveryStatusValue;
  providerRef?: string | null;
  error?: string | null;
}

/**
 * Records one attempt. A concurrent duplicate SENT (the partial unique index)
 * is not an error — the notification did go out once, which is the point.
 */
export async function recordNotificationDelivery(
  db: Executor,
  input: RecordNotificationDeliveryInput,
): Promise<void> {
  try {
    await db.notificationDelivery.create({
      data: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        kind: input.kind,
        subjectKey: input.subjectKey,
        channel: input.channel,
        status: input.status,
        providerRef: input.providerRef ?? null,
        error: input.error ? input.error.slice(0, 500) : null,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
    throw error;
  }
}
