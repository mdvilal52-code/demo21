/**
 * Minimal PII classification/redaction used before anything is logged.
 * This is intentionally conservative: it flags likely-sensitive substrings
 * so logs never carry raw customer content, without trying to be a full DLP
 * engine (that is a Phase 5/6 concern).
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?\d[\d\s-]{7,}\d)/g;
// Simplistic passport-like pattern: 1-2 letters followed by 6-9 digits.
const PASSPORT_RE = /\b[A-Z]{1,2}\d{6,9}\b/g;

export type PiiCategory = 'EMAIL' | 'PHONE' | 'PASSPORT_LIKE';

export interface PiiClassification {
  containsPii: boolean;
  categories: PiiCategory[];
}

export function classifyPII(text: string): PiiClassification {
  const categories: PiiCategory[] = [];
  if (EMAIL_RE.test(text)) categories.push('EMAIL');
  if (PHONE_RE.test(text)) categories.push('PHONE');
  if (PASSPORT_RE.test(text)) categories.push('PASSPORT_LIKE');
  // reset lastIndex on the shared global regexes before returning
  EMAIL_RE.lastIndex = 0;
  PHONE_RE.lastIndex = 0;
  PASSPORT_RE.lastIndex = 0;
  return { containsPii: categories.length > 0, categories };
}

/** Replaces detected PII substrings with a category placeholder for safe logging. */
export function redactPII(text: string): string {
  return text
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(PHONE_RE, '[REDACTED_PHONE]')
    .replace(PASSPORT_RE, '[REDACTED_PASSPORT]');
}
