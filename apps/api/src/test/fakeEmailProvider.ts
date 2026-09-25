import type { EmailProvider, EmailSendResult } from '@ai-concierge/channels';

export interface RecordedEmail {
  to: string;
  subject: string;
  body: string;
}

/** Test-only double — never wired into a production code path (server.ts always constructs a real MailgunEmailProvider or NotConfiguredEmailProvider). */
export class FakeEmailProvider implements EmailProvider {
  readonly name = 'fake-test-double';
  readonly sent: RecordedEmail[] = [];

  async sendEmail(to: string, subject: string, body: string): Promise<EmailSendResult> {
    this.sent.push({ to, subject, body });
    return { status: 'SENT', providerMessageId: `fake-${this.sent.length}` };
  }
}
