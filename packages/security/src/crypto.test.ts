import { describe, expect, it } from 'vitest';
import {
  decryptField,
  deriveSubKey,
  encryptField,
  generateEncryptionKey,
  generateOpaqueToken,
  sha256Hex,
} from './crypto.js';

describe('field encryption', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const key = generateEncryptionKey();
    const ciphertext = encryptField('super-secret-totp-seed', key);
    expect(decryptField(ciphertext, key)).toBe('super-secret-totp-seed');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const key = generateEncryptionKey();
    expect(encryptField('same input', key)).not.toBe(encryptField('same input', key));
  });

  it('fails to decrypt with the wrong key', () => {
    const ciphertext = encryptField('secret', generateEncryptionKey());
    expect(() => decryptField(ciphertext, generateEncryptionKey())).toThrow();
  });

  it('fails to decrypt a tampered ciphertext (authenticated encryption)', () => {
    const key = generateEncryptionKey();
    const ciphertext = encryptField('secret', key);
    const bytes = Buffer.from(ciphertext, 'base64');
    const lastIndex = bytes.length - 1;
    bytes[lastIndex] = bytes[lastIndex]! ^ 0xff;
    expect(() => decryptField(bytes.toString('base64'), key)).toThrow();
  });

  it('rejects a key that is not exactly 32 bytes', () => {
    expect(() => encryptField('x', Buffer.from('too-short').toString('base64'))).toThrow(
      /32 bytes/,
    );
  });
});

describe('sha256Hex', () => {
  it('is deterministic', () => {
    expect(sha256Hex('token-value')).toBe(sha256Hex('token-value'));
  });

  it('differs for different inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});

describe('generateOpaqueToken', () => {
  it('generates unique, sufficiently long tokens', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe('deriveSubKey', () => {
  it('is deterministic for the same master key and purpose', () => {
    const master = generateEncryptionKey();
    expect(deriveSubKey(master, 'pii')).toBe(deriveSubKey(master, 'pii'));
  });

  it('yields an independent key per purpose and per master key', () => {
    const master = generateEncryptionKey();
    expect(deriveSubKey(master, 'pii')).not.toBe(deriveSubKey(master, 'totp'));
    expect(deriveSubKey(master, 'pii')).not.toBe(deriveSubKey(generateEncryptionKey(), 'pii'));
    expect(deriveSubKey(master, 'pii')).not.toBe(master);
  });

  it('yields a valid AES-256 key that round-trips a field', () => {
    const derived = deriveSubKey(generateEncryptionKey(), 'pii');
    expect(Buffer.from(derived, 'base64')).toHaveLength(32);
    expect(decryptField(encryptField('1990-05-12', derived), derived)).toBe('1990-05-12');
  });

  it('rejects a master key of the wrong length', () => {
    expect(() => deriveSubKey(Buffer.from('short').toString('base64'), 'pii')).toThrow(/32 bytes/);
  });
});
