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
