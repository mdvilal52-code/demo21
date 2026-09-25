import { randomUUID } from 'node:crypto';
import { generateOpaqueToken, sha256Hex } from '../crypto.js';

/** Refresh tokens live far longer than access tokens by design — rotation + reuse detection is what bounds their risk, not a short TTL. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssuedRefreshToken {
  /** The raw, opaque token — returned to the client once, never persisted. */
  token: string;
  /** SHA-256 of `token` — what actually gets persisted (packages/db RefreshToken.tokenHash). */
  tokenHash: string;
  /** Groups one rotation chain; unchanged across every rotation in the chain. */
  familyId: string;
  expiresAt: Date;
}

/** A brand-new login: starts a new rotation family. */
export function issueRefreshToken(): IssuedRefreshToken {
  return startFamily(randomUUID());
}

/** A rotation within an existing, still-trusted family (same familyId carried forward). */
export function rotateRefreshToken(familyId: string): IssuedRefreshToken {
  return startFamily(familyId);
}

function startFamily(familyId: string): IssuedRefreshToken {
  const token = generateOpaqueToken();
  return {
    token,
    tokenHash: sha256Hex(token),
    familyId,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  };
}

export function hashRefreshToken(token: string): string {
  return sha256Hex(token);
}
