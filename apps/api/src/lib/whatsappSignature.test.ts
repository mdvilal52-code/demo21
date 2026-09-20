import { signWebhookPayload } from '@ai-concierge/security';
import { describe, expect, it } from 'vitest';
import { verifyMetaWebhookSignature } from './whatsappSignature.js';

describe('verifyMetaWebhookSignature', () => {
  const secret = 'meta-app-secret';
  const body = JSON.stringify({ entry: [] });

  it('accepts a correctly signed body with the sha256= prefix', () => {
    const header = `sha256=${signWebhookPayload(body, secret)}`;
    expect(verifyMetaWebhookSignature(body, header, secret)).toBe(true);
  });

  it('rejects a header missing the sha256= prefix', () => {
    const header = signWebhookPayload(body, secret);
    expect(verifyMetaWebhookSignature(body, header, secret)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const header = `sha256=${signWebhookPayload(body, secret)}`;
    expect(verifyMetaWebhookSignature(JSON.stringify({ entry: ['x'] }), header, secret)).toBe(
      false,
    );
  });

  it('rejects a missing header', () => {
    expect(verifyMetaWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it('rejects an array header (should never happen, but never crash)', () => {
    expect(verifyMetaWebhookSignature(body, ['sha256=x', 'sha256=y'], secret)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const header = `sha256=${signWebhookPayload(body, 'different-secret')}`;
    expect(verifyMetaWebhookSignature(body, header, secret)).toBe(false);
  });
});
