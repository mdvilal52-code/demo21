import {
  MailgunEmailProvider,
  NotConfiguredEmailProvider,
  type EmailProvider,
} from '@ai-concierge/channels';
import type { ApiEnv } from '../env.js';

export type EmailProviderConfig = Pick<
  ApiEnv,
  'MAILGUN_API_KEY' | 'MAILGUN_DOMAIN' | 'MAILGUN_FROM_ADDRESS'
>;

export interface EmailProviderSetup {
  provider: EmailProvider;
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
}

/** Same "every required var or none" rule WhatsApp's four-vars-or-none check uses — a half-configured Mailgun setup is never treated as working. */
export function createEmailProvider(config: EmailProviderConfig): EmailProviderSetup {
  if (!config.MAILGUN_API_KEY || !config.MAILGUN_DOMAIN || !config.MAILGUN_FROM_ADDRESS) {
    return { provider: new NotConfiguredEmailProvider(), status: 'NOT_CONFIGURED' };
  }
  return {
    provider: new MailgunEmailProvider({
      apiKey: config.MAILGUN_API_KEY,
      domain: config.MAILGUN_DOMAIN,
      fromAddress: config.MAILGUN_FROM_ADDRESS,
    }),
    status: 'CONFIGURED',
  };
}
