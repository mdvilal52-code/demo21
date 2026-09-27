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
  /** Set by a test to simulate the next N sends failing (e.g. a Mailgun outage), then recovering. */
  failNextCount = 0;

  async sendEmail(to: string, subject: string, body: string): Promise<EmailSendResult> {
    if (this.failNextCount > 0) {
      this.failNextCount -= 1;
      return { status: 'FAILED', error: 'simulated provider failure' };
    }
    this.sent.push({ to, subject, body });
    return { status: 'SENT', providerMessageId: `fake-${this.sent.length}` };
  }
}
