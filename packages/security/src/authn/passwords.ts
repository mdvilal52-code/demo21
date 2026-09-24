import * as argon2 from 'argon2';

/**
 * argon2id — OWASP's current recommendation for new systems over
 * bcrypt/scrypt. Parameters follow OWASP's password-storage cheat sheet
 * minimums (19 MiB memory, 2 iterations, 1 degree of parallelism) rather
 * than argon2's own lighter defaults.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/** Never throws on a malformed/foreign hash — a verification failure and a corrupt hash look identical to the caller. */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * A fixed, valid argon2id hash of a fixed dummy string — not a secret,
 * verifiable by anyone, secures nothing. Its only purpose: callers that
 * look up a user by email and find none should still run one
 * `verifyPassword(DUMMY_PASSWORD_HASH, input.password)` before responding,
 * so an unknown-email response takes roughly the same time as a wrong-
 * password response on a real account. Without this, argon2's real,
 * deliberately-slow hashing cost only shows up on the "account exists"
 * path, and that latency gap is enough to enumerate valid emails by timing
 * alone even though the two responses are byte-identical.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$EWYANcjMG/75c9K3cYtGQQ$LoL5D2dioKuZ/MF3B6TvtP0wPw26pSWXw3f6o7ezqxk';
