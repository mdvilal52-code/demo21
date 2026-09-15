import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from './webhookSignature.js';

describe('webhook signature', () => {
  const secret = 'a-shared-secret';
  const payload = JSON.stringify({ event: 'message.received', id: '123' });

  it('verifies a signature it produced', () => {
    const signature = signWebhookPayload(payload, secret);
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const signature = signWebhookPayload(payload, secret);
    const tampered = JSON.stringify({ event: 'message.received', id: '999' });
    expect(verifyWebhookSignature(tampered, signature, secret)).toBe(false);
  });

  it('rejects a signature produced with a different secret', () => {
    const signature = signWebhookPayload(payload, 'a-different-secret');
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(false);
  });

  it('rejects a non-hex signature without throwing', () => {
    expect(verifyWebhookSignature(payload, 'not-hex-!!', secret)).toBe(false);
  });

  it('rejects an empty signature', () => {
    expect(verifyWebhookSignature(payload, '', secret)).toBe(false);
  });
});
