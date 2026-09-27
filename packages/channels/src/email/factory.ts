import { MailgunEmailProvider, NotConfiguredEmailProvider, type EmailProvider } from './provider.js';

export interface EmailProviderConfig {
  MAILGUN_API_KEY?: string;
  MAILGUN_DOMAIN?: string;
  MAILGUN_FROM_ADDRESS?: string;
}

export interface EmailProviderSetup {
  provider: EmailProvider;
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
}

/**
 * Shared by every process that needs to send email (apps/api for inbound
 * replies and staff replies, apps/worker for the resend sweep) so "how to
 * build an EmailProvider from config" exists exactly once. Same "every
 * required var or none" rule WhatsApp's four-vars-or-none check uses — a
 * half-configured Mailgun setup is never treated as working.
 */
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
