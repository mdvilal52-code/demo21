import type { Redis } from 'ioredis';
import { ACCESS_TOKEN_TTL_SECONDS } from '@ai-concierge/security';

const KEY_PREFIX = 'revoked-session-family:';

/**
 * Backs immediate session revocation ("automatic restricted response" —
 * docs/SECURITY-MODEL.md). An access token is a self-contained JWT valid
 * until its own `exp`, so revoking a refresh-token family alone would still
 * leave any already-issued access token from that family usable for up to
 * ACCESS_TOKEN_TTL_SECONDS more. Marking the family here and checking it on
 * every authenticated request (plugins/auth.ts) closes that window
 * immediately instead. The TTL matches the access-token lifetime — nothing
 * from a family older than that could still be valid anyway, so the set
 * never needs unbounded cleanup.
 */
export async function revokeSessionFamily(redis: Redis, familyId: string): Promise<void> {
  await redis.set(KEY_PREFIX + familyId, '1', 'EX', ACCESS_TOKEN_TTL_SECONDS);
}

export async function isSessionFamilyRevoked(redis: Redis, familyId: string): Promise<boolean> {
  const value = await redis.get(KEY_PREFIX + familyId);
  return value !== null;
}
