import type { NotificationProvider } from '../lib/notificationProvider.js';
import { NotificationChannel, NotificationSendStatus } from '@ai-concierge/domain';

export interface RecordedSms {
  to: string;
  body: string;
}

/** Test-only double — never wired into a production code path (server.ts always constructs a real or NotConfigured provider). */
export class FakeNotificationProvider implements NotificationProvider {
  readonly sent: RecordedSms[] = [];

  async sendSms(to: string, body: string) {
    this.sent.push({ to, body });
    return {
      channel: NotificationChannel.SMS,
      status: NotificationSendStatus.SENT,
      providerRef: `fake-${this.sent.length}`,
      error: null,
    };
  }
}
