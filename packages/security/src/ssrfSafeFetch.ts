import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const PRIVATE_IPV4_PREFIXES = ['10.', '192.168.', '169.254.', '127.'];

function isPrivateIPv4(address: string): boolean {
  if (PRIVATE_IPV4_PREFIXES.some((prefix) => address.startsWith(prefix))) return true;
  // 172.16.0.0 – 172.31.255.255
  const match = /^172\.(\d{1,3})\./.exec(address);
  if (match?.[1]) {
    const second = Number(match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return address === '0.0.0.0';
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized.startsWith('fe80:') || // link-local
    normalized.startsWith('fc') || // unique local fc00::/7
    normalized.startsWith('fd')
  );
}

function isPrivateAddress(address: string): boolean {
  if (isIPv4(address)) return isPrivateIPv4(address);
  if (isIPv6(address)) return isPrivateIPv6(address);
  return true; // unknown shape — fail closed
}

/** Hosts that are expected to resolve to a private/loopback address in local dev. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export interface SsrfSafeFetchOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * A fetch wrapper for any outbound call whose target is (even partially)
 * configuration-driven rather than a hardcoded internal URL: verifies the
 * hostname is on the allowlist, resolves DNS to catch rebinding to a
 * private/link-local address (e.g. a cloud metadata endpoint), and refuses
 * to silently follow redirects — the caller must re-validate any redirect
 * target through this same function.
 */
export async function ssrfSafeFetch(
  targetUrl: string,
  allowedHosts: string[],
  options: SsrfSafeFetchOptions = {},
): Promise<Response> {
  const url = new URL(targetUrl);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`Blocked non-HTTP protocol: ${url.protocol}`);
  }

  const hostname = url.hostname.toLowerCase();
  const normalizedAllowlist = allowedHosts.map((host) => host.toLowerCase());
  if (!normalizedAllowlist.includes(hostname)) {
    throw new SsrfBlockedError(`Host not on outbound allowlist: ${hostname}`);
  }

  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    const resolved = await lookup(hostname, { all: true });
    const blocked = resolved.find((entry) => isPrivateAddress(entry.address));
    if (blocked) {
      throw new SsrfBlockedError(
        `Host ${hostname} resolved to a private address (${blocked.address}); refusing to call it`,
      );
    }
  }

  const { timeoutMs = 5000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new SsrfBlockedError(
        `Refusing to follow redirect from ${hostname} (status ${response.status})`,
      );
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
