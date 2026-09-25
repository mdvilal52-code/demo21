import { AppError } from '@ai-concierge/domain';

/**
 * Seam for federating login to an external OIDC/OAuth2 identity provider
 * (Okta, Auth0, Entra ID, …). MASTER-PLAN.md §3 names OIDC/OAuth2 as the
 * chosen AuthN approach, but §9's decisions table never picked a concrete
 * provider — so, exactly like `AIProvider`/`WhatsAppClient` before it, this
 * interface exists now and a `NotConfiguredIdentityProvider` is the default,
 * while local email+password+TOTP (passwords.ts, totp.ts, accessTokens.ts,
 * refreshTokens.ts) is the fully real, working AuthN implementation until a
 * provider is chosen and an adapter is written against this seam.
 */
export interface IdentityProvider {
  readonly name: string;
  buildAuthorizationUrl(state: string, redirectUri: string): string;
  exchangeCodeForProfile(code: string, redirectUri: string): Promise<ExternalIdentity>;
}

export interface ExternalIdentity {
  subject: string;
  email: string;
}

export class NotConfiguredIdentityProvider implements IdentityProvider {
  readonly name = 'not-configured';

  buildAuthorizationUrl(): never {
    throw new AppError(
      'NOT_CONFIGURED',
      'No external identity provider is configured for this environment',
    );
  }

  async exchangeCodeForProfile(): Promise<ExternalIdentity> {
    throw new AppError(
      'NOT_CONFIGURED',
      'No external identity provider is configured for this environment',
    );
  }
}
