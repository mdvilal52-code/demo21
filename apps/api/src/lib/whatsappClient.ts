import { ssrfSafeFetch } from '@ai-concierge/security';
import { AppError } from '@ai-concierge/domain';
import type { ApiEnv } from '../env.js';

const GRAPH_API_HOST = 'graph.facebook.com';
const GRAPH_API_VERSION = 'v21.0';

export interface WhatsAppClient {
  sendTextMessage(to: string, body: string): Promise<void>;
}

/** Reported via AppContext.whatsappStatus so this surfaces the same way OTel/AI providers do. */
export class NotConfiguredWhatsAppClient implements WhatsAppClient {
  async sendTextMessage(_to: string, _body: string): Promise<void> {
    throw new AppError(
      'NOT_CONFIGURED',
      'WhatsApp is not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing)',
    );
  }
}

export interface MetaCloudApiConfig {
  accessToken: string;
  phoneNumberId: string;
}

export class MetaCloudApiWhatsAppClient implements WhatsAppClient {
  constructor(private readonly config: MetaCloudApiConfig) {}

  async sendTextMessage(to: string, body: string): Promise<void> {
    const url = `https://${GRAPH_API_HOST}/${GRAPH_API_VERSION}/${this.config.phoneNumberId}/messages`;
    const response = await ssrfSafeFetch(url, [GRAPH_API_HOST], {
      method: 'POST',
      timeoutMs: 10_000,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body, preview_url: false },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new AppError('UPSTREAM_UNAVAILABLE', 'WhatsApp send failed', {
        details: { status: response.status },
        cause: errorBody,
      });
    }
  }
}

export type WhatsAppConfig = Pick<
  ApiEnv,
  | 'WHATSAPP_ACCESS_TOKEN'
  | 'WHATSAPP_PHONE_NUMBER_ID'
  | 'WHATSAPP_VERIFY_TOKEN'
  | 'WHATSAPP_APP_SECRET'
>;

export interface WhatsAppSetup {
  client: WhatsAppClient;
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
}

/**
 * All four env vars or none — a partially-configured adapter (e.g. a token
 * but no verify token) is treated as NOT_CONFIGURED rather than guessing
 * which half to trust. Shared by server.ts and buildTestApp.ts so both
 * construct the client the same way.
 */
export function createWhatsAppClient(config: WhatsAppConfig): WhatsAppSetup {
  const {
    WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_APP_SECRET,
  } = config;
  if (
    WHATSAPP_ACCESS_TOKEN &&
    WHATSAPP_PHONE_NUMBER_ID &&
    WHATSAPP_VERIFY_TOKEN &&
    WHATSAPP_APP_SECRET
  ) {
    return {
      client: new MetaCloudApiWhatsAppClient({
        accessToken: WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
      }),
      status: 'CONFIGURED',
    };
  }
  return { client: new NotConfiguredWhatsAppClient(), status: 'NOT_CONFIGURED' };
}
