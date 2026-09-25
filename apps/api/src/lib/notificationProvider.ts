import { ssrfSafeFetch } from '@ai-concierge/security';
import {
  NotificationChannel,
  NotificationSendStatus,
  type NotificationSendResult,
} from '@ai-concierge/domain';
import type { ApiEnv } from '../env.js';

const TWILIO_API_HOST = 'api.twilio.com';

/**
 * Staff notification — SMS to the worker `EscalationCase.assignedToUserId`
 * (or the tier's on-call number, once such a directory exists) is assigned
 * to, per the project brief: "AI kaam nahi kar paye toh human worker ko sms
 * kar de." Same "result object, never a thrown error" convention
 * `WhatsAppProvider.sendTextMessage` already established — a failed or
 * unconfigured page must never fail the escalation itself; the case is
 * already persisted and visible on the dashboard regardless.
 */
export interface NotificationProvider {
  sendSms(to: string, body: string): Promise<NotificationSendResult>;
}

export class NotConfiguredNotificationProvider implements NotificationProvider {
  async sendSms(_to: string, _body: string): Promise<NotificationSendResult> {
    return {
      channel: NotificationChannel.SMS,
      status: NotificationSendStatus.NOT_CONFIGURED,
      providerRef: null,
      error: null,
    };
  }
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

/**
 * Direct REST adapter (no SDK — same convention as `MetaWhatsAppProvider`/
 * `GeminiProvider`: one `ssrfSafeFetch` call against a single hardcoded
 * host). Basic auth is Twilio's own documented mechanism for this endpoint;
 * the auth token never appears in a URL or a log line. `fetchImpl` is
 * injectable so tests substitute a fake without a real network call, same
 * convention as `MetaWhatsAppProvider`/`MailgunEmailProvider`.
 */
export class TwilioNotificationProvider implements NotificationProvider {
  constructor(
    private readonly config: TwilioConfig,
    private readonly fetchImpl: typeof ssrfSafeFetch = ssrfSafeFetch,
  ) {}

  async sendSms(to: string, body: string): Promise<NotificationSendResult> {
    const url = `https://${TWILIO_API_HOST}/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;
    const basicAuth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString(
      'base64',
    );
    try {
      const response = await this.fetchImpl(url, [TWILIO_API_HOST], {
        method: 'POST',
        timeoutMs: 10_000,
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: this.config.fromNumber, Body: body }).toString(),
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        return {
          channel: NotificationChannel.SMS,
          status: NotificationSendStatus.FAILED,
          providerRef: null,
          error: `Twilio responded ${response.status}: ${errorBody.slice(0, 300)}`,
        };
      }
      const data = (await response.json()) as { sid?: string };
      return {
        channel: NotificationChannel.SMS,
        status: NotificationSendStatus.SENT,
        providerRef: data.sid ?? null,
        error: null,
      };
    } catch (cause) {
      return {
        channel: NotificationChannel.SMS,
        status: NotificationSendStatus.FAILED,
        providerRef: null,
        error: cause instanceof Error ? cause.message : 'Unknown error sending SMS',
      };
    }
  }
}

export type NotificationConfig = Pick<
  ApiEnv,
  'TWILIO_ACCOUNT_SID' | 'TWILIO_AUTH_TOKEN' | 'TWILIO_FROM_NUMBER'
>;

export interface NotificationProviderSetup {
  provider: NotificationProvider;
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
}

export function createNotificationProvider(config: NotificationConfig): NotificationProviderSetup {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN || !config.TWILIO_FROM_NUMBER) {
    return { provider: new NotConfiguredNotificationProvider(), status: 'NOT_CONFIGURED' };
  }
  return {
    provider: new TwilioNotificationProvider({
      accountSid: config.TWILIO_ACCOUNT_SID,
      authToken: config.TWILIO_AUTH_TOKEN,
      fromNumber: config.TWILIO_FROM_NUMBER,
    }),
    status: 'CONFIGURED',
  };
}
