import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Double-submit-cookie CSRF primitive. Not mounted anywhere in Phase 1 — the
 * API is stateless/token-based and the web app calls it server-to-server,
 * so there is no browser session cookie for CSRF to target yet. It ships
 * now, tested, so Phase 5+ (once a cookie-based admin session exists) wires
 * it in rather than inventing it under deadline pressure.
 */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

export function verifyCsrfToken(
  cookieToken: string | undefined,
  headerToken: string | undefined,
): boolean {
  if (!cookieToken || !headerToken) return false;
  const a = Buffer.from(cookieToken, 'utf8');
  const b = Buffer.from(headerToken, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
