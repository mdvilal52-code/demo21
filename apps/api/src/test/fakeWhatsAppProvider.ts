import type { WhatsAppProvider, WhatsAppSendResult } from '@ai-concierge/channels';

export interface RecordedWhatsAppMessage {
  to: string;
  body: string;
}

export interface RecordedWhatsAppImage {
  to: string;
  imageUrl: string;
  caption: string;
}

/**
 * Test-only double — never wired into a production code path (server.ts
 * always constructs a real MetaWhatsAppProvider or NotConfiguredWhatsAppProvider).
 * Records what would have been sent so tests can assert on the exact
 * deterministic reply text without a real network call.
 */
export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'fake-test-double';
  readonly sent: RecordedWhatsAppMessage[] = [];
  readonly sentImages: RecordedWhatsAppImage[] = [];

  async sendTextMessage(to: string, body: string): Promise<WhatsAppSendResult> {
    this.sent.push({ to, body });
    return { status: 'SENT', providerMessageId: `fake-${this.sent.length}` };
  }

  async sendImageMessage(to: string, imageUrl: string, caption: string): Promise<WhatsAppSendResult> {
    this.sentImages.push({ to, imageUrl, caption });
    return { status: 'SENT', providerMessageId: `fake-image-${this.sentImages.length}` };
  }
}
