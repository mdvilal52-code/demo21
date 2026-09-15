/**
 * Secure header / CSP policy, framework-agnostic so it can be handed to
 * @fastify/helmet (apps/api) or a Next.js middleware (apps/web) alike.
 */
export interface SecureHeadersPolicy {
  contentSecurityPolicy: {
    directives: Record<string, string[]>;
  };
  referrerPolicy: string;
  crossOriginResourcePolicy: 'same-site' | 'same-origin' | 'cross-origin';
  hstsMaxAgeSeconds: number;
}

/**
 * Deny-by-default CSP: no inline scripts, no third-party origins, no
 * framing. Tighten further per app if a real need appears; never loosen to
 * 'unsafe-inline' or a wildcard source.
 */
export function buildSecureHeadersPolicy(): SecureHeadersPolicy {
  return {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    referrerPolicy: 'no-referrer',
    crossOriginResourcePolicy: 'same-origin',
    hstsMaxAgeSeconds: 15552000, // 180 days
  };
}
