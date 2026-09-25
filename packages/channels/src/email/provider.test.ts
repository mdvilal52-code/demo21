import { describe, expect, it, vi } from 'vitest';
import { MailgunEmailProvider, NotConfiguredEmailProvider } from './provider.js';

describe('NotConfiguredEmailProvider', () => {
  it('returns an explicit NOT_CONFIGURED result rather than throwing', async () => {
    const provider = new NotConfiguredEmailProvider();
    await expect(provider.sendEmail('customer@example.com', 'Subject', 'Body')).resolves.toEqual({
      status: 'NOT_CONFIGURED',
    });
  });
});

describe('MailgunEmailProvider', () => {
  const config = {
    apiKey: 'key-abc',
    domain: 'mail.fleet.example.com',
    fromAddress: 'concierge@fleet.example.com',
  };

  it('calls the Mailgun API with the expected URL, auth header and body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: '<reply-1@mailgun.org>' }),
    });
    const provider = new MailgunEmailProvider(config, fetchImpl as never);

    const result = await provider.sendEmail('customer@example.com', 'Your quote', 'Hello there');

    expect(result).toEqual({ status: 'SENT', providerMessageId: '<reply-1@mailgun.org>' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, allowedHosts, options] = fetchImpl.mock.calls[0] as [
      string,
      string[],
      RequestInit & { timeoutMs?: number },
    ];
    expect(url).toBe('https://api.mailgun.net/v3/mail.fleet.example.com/messages');
    expect(allowedHosts).toEqual(['api.mailgun.net']);
    expect(options.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('api:key-abc').toString('base64')}`,
    });
    const body = new URLSearchParams(options.body as string);
    expect(body.get('from')).toBe('concierge@fleet.example.com');
    expect(body.get('to')).toBe('customer@example.com');
    expect(body.get('subject')).toBe('Your quote');
    expect(body.get('text')).toBe('Hello there');
  });

  it('returns FAILED (never throws) when Mailgun responds with an error status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Forbidden',
    });
    const provider = new MailgunEmailProvider(config, fetchImpl as never);

    const result = await provider.sendEmail('customer@example.com', 'Subject', 'Body');
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('401');
  });

  it('returns FAILED (never throws) when the network call itself rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('timed out'));
    const provider = new MailgunEmailProvider(config, fetchImpl as never);

    const result = await provider.sendEmail('customer@example.com', 'Subject', 'Body');
    expect(result).toEqual({ status: 'FAILED', error: 'timed out' });
  });
});
