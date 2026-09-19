import { describe, expect, it, vi } from 'vitest';
import { MetaWhatsAppProvider, NotConfiguredWhatsAppProvider } from './provider.js';

describe('NotConfiguredWhatsAppProvider', () => {
  it('returns an explicit NOT_CONFIGURED result rather than throwing', async () => {
    const provider = new NotConfiguredWhatsAppProvider();
    await expect(provider.sendTextMessage('971500000000', 'hi')).resolves.toEqual({
      status: 'NOT_CONFIGURED',
    });
  });
});

describe('MetaWhatsAppProvider', () => {
  const config = { accessToken: 'token-abc', phoneNumberId: '1234567890', apiVersion: 'v21.0' };

  it('calls the Graph API with the expected URL, auth header and body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.reply-1' }] }),
    });
    const provider = new MetaWhatsAppProvider(config, fetchImpl as never);

    const result = await provider.sendTextMessage('971501234567', 'hello there');

    expect(result).toEqual({ status: 'SENT', providerMessageId: 'wamid.reply-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, allowedHosts, options] = fetchImpl.mock.calls[0] as [
      string,
      string[],
      RequestInit & { timeoutMs?: number },
    ];
    expect(url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(allowedHosts).toEqual(['graph.facebook.com']);
    expect(options.headers).toMatchObject({ authorization: 'Bearer token-abc' });
    expect(JSON.parse(options.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '971501234567',
      type: 'text',
      text: { body: 'hello there' },
    });
  });

  it('returns FAILED (never throws) when the Graph API responds with an error status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Invalid OAuth access token',
    });
    const provider = new MetaWhatsAppProvider(config, fetchImpl as never);

    const result = await provider.sendTextMessage('971501234567', 'hello');
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('401');
  });

  it('returns FAILED (never throws) when the network call itself rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('timed out'));
    const provider = new MetaWhatsAppProvider(config, fetchImpl as never);

    const result = await provider.sendTextMessage('971501234567', 'hello');
    expect(result).toEqual({ status: 'FAILED', error: 'timed out' });
  });
});
