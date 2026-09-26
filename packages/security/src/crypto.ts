import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Field-level encryption for the PII/secrets this codebase actually stores
 * today (a User's TOTP MFA seed — see packages/db User.mfaSecretCiphertext).
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt
 * rather than silently returning garbage. Passport/licence-number encryption
 * (MASTER-PLAN.md §6) reuses this same primitive once the document pipeline
 * that stores those numbers exists (docs/PHASE-6.md §3).
 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

function loadKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must decode to exactly ${KEY_BYTES} bytes (AES-256); got ${key.length}`,
    );
  }
  return key;
}

/**
 * Derives an independent AES-256 key for one purpose from a master key
 * (HKDF-SHA256, purpose as the `info`). Lets a new class of encrypted field
 * (e.g. customer dates of birth) get its own key without a new secret to
 * provision, while keeping it cryptographically separate from the master
 * key's other uses (e.g. TOTP seeds) — compromising one derived key reveals
 * nothing about another.
 */
export function deriveSubKey(masterKeyBase64: string, purpose: string): string {
  const master = loadKey(masterKeyBase64);
  const derived = hkdfSync('sha256', master, Buffer.alloc(0), `ai-concierge:${purpose}`, KEY_BYTES);
  return Buffer.from(derived).toString('base64');
}

/** Returns `base64(iv || authTag || ciphertext)` — self-contained, nothing else to store alongside it. */
export function encryptField(plaintext: string, keyBase64: string): string {
  const key = loadKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptField(ciphertextBase64: string, keyBase64: string): string {
  const key = loadKey(keyBase64);
  const raw = Buffer.from(ciphertextBase64, 'base64');
  if (raw.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error('Ciphertext is too short to contain an IV and auth tag');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** SHA-256 hex digest — used to store refresh tokens at rest without ever persisting the raw token. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A random, URL-safe opaque token (refresh tokens, etc.) — 256 bits of entropy by default. */
export function generateOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}
