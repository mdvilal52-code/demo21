import { deriveSubKey } from '@ai-concierge/security';
import type { ApiEnv } from '../env.js';

/**
 * The AES-256 key customer PII (today: the date of birth collected for
 * Step 5) is encrypted with. A dedicated `PII_ENCRYPTION_KEY` wins when set;
 * otherwise a purpose-separated subkey is derived from `MFA_ENCRYPTION_KEY`,
 * so enabling this needs no new secret while still keeping it independent of
 * the key that protects TOTP seeds.
 */
export function resolvePiiKey(
  config: Pick<ApiEnv, 'PII_ENCRYPTION_KEY' | 'MFA_ENCRYPTION_KEY'>,
): string {
  return config.PII_ENCRYPTION_KEY ?? deriveSubKey(config.MFA_ENCRYPTION_KEY, 'pii-v1');
}
