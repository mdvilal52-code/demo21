import { describe, expect, it, vi } from 'vitest';
import {
  createNotificationProvider,
  NotConfiguredNotificationProvider,
  TwilioNotificationProvider,
} from './notificationProvider.js';

describe('NotConfiguredNotificationProvider', () => {
  it('returns an explicit NOT_CONFIGURED result rather than throwing', async () => {
    const provider = new NotConfiguredNotificationProvider();
    const result = await provider.sendSms('+15550001111', 'a worker was needed');
    expect(result).toEqual({
      channel: 'SMS',
      status: 'NOT_CONFIGURED',
      providerRef: null,
      error: null,
    });
  });
});

describe('TwilioNotificationProvider', () => {
  const config = { accountSid: 'AC-test', authToken: 'token-abc', fromNumber: '+15550009999' };

  it('calls the Twilio API with the expected URL, basic auth and form body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sid: 'SM123' }) });
    const provider = new TwilioNotificationProvider(config, fetchImpl as never);

    const result = await provider.sendSms('+15550001111', 'escalation case #42 needs you');

    expect(result).toEqual({
      channel: 'SMS',
      status: 'SENT',
      providerRef: 'SM123',
      error: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, allowedHosts, options] = fetchImpl.mock.calls[0] as [
      string,
      string[],
      RequestInit & { timeoutMs?: number },
    ];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC-test/Messages.json');
    expect(allowedHosts).toEqual(['api.twilio.com']);
    expect(options.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('AC-test:token-abc').toString('base64')}`,
    });
    const body = new URLSearchParams(options.body as string);
    expect(body.get('To')).toBe('+15550001111');
    expect(body.get('From')).toBe('+15550009999');
    expect(body.get('Body')).toBe('escalation case #42 needs you');
  });

  it('returns FAILED (never throws) on a non-ok Twilio response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: async () => 'Authenticate' });
    const provider = new TwilioNotificationProvider(config, fetchImpl as never);

    const result = await provider.sendSms('+15550001111', 'x');
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('401');
  });

  it('returns FAILED (never throws) when the network call itself rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('timed out'));
    const provider = new TwilioNotificationProvider(config, fetchImpl as never);

    const result = await provider.sendSms('+15550001111', 'x');
    expect(result.status).toBe('FAILED');
    expect(result.error).toBe('timed out');
  });
});

describe('createNotificationProvider', () => {
  it('is NOT_CONFIGURED when any Twilio var is missing', () => {
    expect(
      createNotificationProvider({
        TWILIO_ACCOUNT_SID: undefined,
        TWILIO_AUTH_TOKEN: 'token',
        TWILIO_FROM_NUMBER: '+15550009999',
      }).status,
    ).toBe('NOT_CONFIGURED');
  });

  it('is CONFIGURED with a real TwilioNotificationProvider once all three vars are set', () => {
    const setup = createNotificationProvider({
      TWILIO_ACCOUNT_SID: 'AC-test',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_FROM_NUMBER: '+15550009999',
    });
    expect(setup.status).toBe('CONFIGURED');
    expect(setup.provider).toBeInstanceOf(TwilioNotificationProvider);
  });
});
