import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwords.js';

describe('password hashing', () => {
  it('verifies a correct password against its hash', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-Staple-1');
    expect(await verifyPassword(hash, 'Correct-Horse-Battery-Staple-1')).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-Staple-1');
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  });

  it('never stores the plaintext in the hash', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-Staple-1');
    expect(hash).not.toContain('Correct-Horse-Battery-Staple-1');
  });

  it('produces a different hash each time (random salt)', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });

  it('returns false, not a throw, for a malformed hash', async () => {
    expect(await verifyPassword('not-a-real-argon2-hash', 'anything')).toBe(false);
  });
});
