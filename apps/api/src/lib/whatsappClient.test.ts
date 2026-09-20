import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@ai-concierge/domain';

const mocks = vi.hoisted(() => ({ ssrfSafeFetch: vi.fn() }));

vi.mock('@ai-concierge/security', () => ({ ssrfSafeFetch: mocks.ssrfSafeFetch }));

const { createWhatsAppClient, MetaCloudApiWhatsAppClient, NotConfiguredWhatsAppClient } =
  await import('./whatsappClient.js');

describe('NotConfiguredWhatsAppClient', () => {
  it('throws NOT_CONFIGURED on send', async () => {
    const client = new NotConfiguredWhatsAppClient();
    await expect(client.sendTextMessage('971501234567', 'hi')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    await expect(client.sendTextMessage('971501234567', 'hi')).rejects.toBeInstanceOf(AppError);
  });
});

describe('MetaCloudApiWhatsAppClient', () => {
  beforeEach(() => {
    mocks.ssrfSafeFetch.mockReset();
  });

  it('posts to the Graph API with the bearer token and message body', async () => {
    mocks.ssrfSafeFetch.mockResolvedValue({ ok: true });
    const client = new MetaCloudApiWhatsAppClient({
      accessToken: 'token-123',
      phoneNumberId: '1234567890',
    });

    await client.sendTextMessage('971501234567', 'hello there');

    expect(mocks.ssrfSafeFetch).toHaveBeenCalledWith(
      'https://graph.facebook.com/v21.0/1234567890/messages',
      ['graph.facebook.com'],
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
      }),
    );
    const call = mocks.ssrfSafeFetch.mock.calls[0];
    const body = JSON.parse((call?.[2] as { body: string }).body);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '971501234567',
      type: 'text',
      text: { body: 'hello there', preview_url: false },
    });
  });

  it('throws UPSTREAM_UNAVAILABLE when Meta responds with a non-ok status', async () => {
    mocks.ssrfSafeFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"Invalid OAuth token"}}',
    });
    const client = new MetaCloudApiWhatsAppClient({ accessToken: 'bad', phoneNumberId: '123' });

    await expect(client.sendTextMessage('971501234567', 'hi')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
});

describe('createWhatsAppClient', () => {
  it('reports NOT_CONFIGURED when any of the four env vars is missing', () => {
    const { status, client } = createWhatsAppClient({
      WHATSAPP_ACCESS_TOKEN: 'token',
      WHATSAPP_PHONE_NUMBER_ID: undefined,
      WHATSAPP_VERIFY_TOKEN: 'verify',
      WHATSAPP_APP_SECRET: 'secret',
    });
    expect(status).toBe('NOT_CONFIGURED');
    expect(client).toBeInstanceOf(NotConfiguredWhatsAppClient);
  });

  it('reports CONFIGURED and builds a real client when all four are set', () => {
    const { status, client } = createWhatsAppClient({
      WHATSAPP_ACCESS_TOKEN: 'token',
      WHATSAPP_PHONE_NUMBER_ID: '123',
      WHATSAPP_VERIFY_TOKEN: 'verify',
      WHATSAPP_APP_SECRET: 'secret',
    });
    expect(status).toBe('CONFIGURED');
    expect(client).toBeInstanceOf(MetaCloudApiWhatsAppClient);
  });

  it('reports NOT_CONFIGURED when nothing is set', () => {
    const { status } = createWhatsAppClient({
      WHATSAPP_ACCESS_TOKEN: undefined,
      WHATSAPP_PHONE_NUMBER_ID: undefined,
      WHATSAPP_VERIFY_TOKEN: undefined,
      WHATSAPP_APP_SECRET: undefined,
    });
    expect(status).toBe('NOT_CONFIGURED');
  });
});
