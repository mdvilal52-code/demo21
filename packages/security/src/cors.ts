/**
 * Explicit allowlist matching — never a wildcard, never a substring match.
 * `allowedOrigins` should come from validated config (see @ai-concierge/config).
 */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

export function buildCorsOriginChecker(allowedOrigins: string[]) {
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Same-origin / non-browser requests (no Origin header) are allowed through;
    // the rate limiter and auth layers still apply to them.
    if (!origin) {
      callback(null, true);
      return;
    }
    if (isOriginAllowed(origin, allowedOrigins)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed: ${origin}`), false);
  };
}
