import { ssrfSafeFetch } from '@ai-concierge/security';

export type WhatsAppSendStatus = 'SENT' | 'NOT_CONFIGURED' | 'FAILED';

export interface WhatsAppSendResult {
  status: WhatsAppSendStatus;
  providerMessageId?: string;
  error?: string;
}

/**
 * A result object, not a thrown error — sending the outbound reply must
 * never fail the inbound webhook ack Meta is waiting on. Every branch
 * (SENT/NOT_CONFIGURED/FAILED) is explicit and auditable; never a fake SENT.
 */
export interface WhatsAppProvider {
  readonly name: string;
  sendTextMessage(to: string, body: string): Promise<WhatsAppSendResult>;
}

/** No WhatsApp credentials configured for this environment. */
export class NotConfiguredWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'not-configured';

  async sendTextMessage(_to: string, _body: string): Promise<WhatsAppSendResult> {
    return { status: 'NOT_CONFIGURED' };
  }
}

const GRAPH_API_HOST = 'graph.facebook.com';

export interface MetaWhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
}

interface GraphSendResponseShape {
  messages?: { id?: string }[];
}

/**
 * Real Meta Cloud API adapter. The Graph API host is fixed, not
 * config-driven — least privilege: this provider can reach exactly one
 * third-party host, independent of the generic OUTBOUND_ALLOWED_HOSTS list.
 * `fetchImpl` is injectable so tests can substitute a fake without a real
 * network call, per the "test doubles only in test code" rule.
 */
export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'meta-cloud-api';

  constructor(
    private readonly config: MetaWhatsAppConfig,
    private readonly fetchImpl: typeof ssrfSafeFetch = ssrfSafeFetch,
  ) {}

  async sendTextMessage(to: string, body: string): Promise<WhatsAppSendResult> {
    const url = `https://${GRAPH_API_HOST}/${this.config.apiVersion}/${this.config.phoneNumberId}/messages`;
    try {
      const response = await this.fetchImpl(url, [GRAPH_API_HOST], {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.accessToken}`,
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
        timeoutMs: 8000,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          status: 'FAILED',
          error: `Graph API responded ${response.status}: ${text.slice(0, 300)}`,
        };
      }

      const json = (await response.json().catch(() => null)) as GraphSendResponseShape | null;
      const providerMessageId = json?.messages?.[0]?.id;
      return { status: 'SENT', ...(providerMessageId ? { providerMessageId } : {}) };
    } catch (error) {
      return { status: 'FAILED', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
