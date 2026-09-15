import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SsrfBlockedError, ssrfSafeFetch } from './ssrfSafeFetch.js';

describe('ssrfSafeFetch', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://127.0.0.1/ok' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a host that is not on the allowlist, without attempting the network call', async () => {
    await expect(ssrfSafeFetch('http://attacker.example/steal', ['127.0.0.1'])).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it('rejects non-HTTP protocols such as file://', async () => {
    await expect(ssrfSafeFetch('file:///etc/passwd', ['etc'])).rejects.toThrow(SsrfBlockedError);
  });

  it('allows a call to an allowlisted loopback host', async () => {
    const response = await ssrfSafeFetch(`${baseUrl}/ok`, ['127.0.0.1']);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('refuses to silently follow a redirect', async () => {
    await expect(ssrfSafeFetch(`${baseUrl}/redirect`, ['127.0.0.1'])).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it('blocks an allowlisted hostname that resolves (DNS rebinding) to a private address', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn().mockResolvedValue([{ address: '169.254.169.254', family: 4 }]),
    }));
    vi.resetModules();
    const { ssrfSafeFetch: reboundFetch, SsrfBlockedError: ReboundError } =
      await import('./ssrfSafeFetch.js');
    await expect(
      reboundFetch('http://partner.example.com/webhook', ['partner.example.com']),
    ).rejects.toThrow(ReboundError);
    vi.doUnmock('node:dns/promises');
    vi.resetModules();
  });
});
