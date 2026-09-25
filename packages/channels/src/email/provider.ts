import { ssrfSafeFetch } from '@ai-concierge/security';

export type EmailSendStatus = 'SENT' | 'NOT_CONFIGURED' | 'FAILED';

export interface EmailSendResult {
  status: EmailSendStatus;
  providerMessageId?: string;
  error?: string;
}

/**
 * A result object, not a thrown error — same convention as
 * `WhatsAppProvider.sendTextMessage`: a failed or unconfigured send must
 * never fail the inbound webhook ack Mailgun is waiting on. Reused as-is by
 * `apps/api/src/lib/notificationProvider.ts` for staff escalation emails —
 * one provider, two callers, never two copies of "how to send an email".
 */
export interface EmailProvider {
  readonly name: string;
  sendEmail(to: string, subject: string, body: string): Promise<EmailSendResult>;
}

export class NotConfiguredEmailProvider implements EmailProvider {
  readonly name = 'not-configured';

  async sendEmail(_to: string, _subject: string, _body: string): Promise<EmailSendResult> {
    return { status: 'NOT_CONFIGURED' };
  }
}

const MAILGUN_API_HOST = 'api.mailgun.net';

export interface MailgunConfig {
  apiKey: string;
  domain: string;
  fromAddress: string;
}

interface MailgunSendResponseShape {
  id?: string;
}

/**
 * Real Mailgun adapter. The API host is fixed, not config-driven — same
 * least-privilege posture as `MetaWhatsAppProvider`/`GeminiProvider`:
 * this provider can reach exactly one third-party host, independent of
 * the generic `OUTBOUND_ALLOWED_HOSTS` list. `fetchImpl` is injectable so
 * tests substitute a fake without a real network call.
 */
export class MailgunEmailProvider implements EmailProvider {
  readonly name = 'mailgun';

  constructor(
    private readonly config: MailgunConfig,
    private readonly fetchImpl: typeof ssrfSafeFetch = ssrfSafeFetch,
  ) {}

  async sendEmail(to: string, subject: string, body: string): Promise<EmailSendResult> {
    const url = `https://${MAILGUN_API_HOST}/v3/${this.config.domain}/messages`;
    const basicAuth = Buffer.from(`api:${this.config.apiKey}`).toString('base64');
    try {
      const response = await this.fetchImpl(url, [MAILGUN_API_HOST], {
        method: 'POST',
        headers: {
          authorization: `Basic ${basicAuth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          from: this.config.fromAddress,
          to,
          subject,
          text: body,
        }).toString(),
        timeoutMs: 8000,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          status: 'FAILED',
          error: `Mailgun responded ${response.status}: ${text.slice(0, 300)}`,
        };
      }

      const json = (await response.json().catch(() => null)) as MailgunSendResponseShape | null;
      return { status: 'SENT', ...(json?.id ? { providerMessageId: json.id } : {}) };
    } catch (error) {
      return { status: 'FAILED', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
