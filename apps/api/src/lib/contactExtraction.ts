/**
 * Pulls contact details a customer typed into a chat message. Deterministic
 * and deliberately conservative: it only returns what is unmistakably an
 * email address or a phone number (or an explicitly announced name) — a
 * booking date, a passport number or a price must never be mistaken for a
 * phone number, because a wrong number means an SMS to a stranger.
 */

export interface ExtractedContact {
  email?: string;
  /** E.164, e.g. +971501234567 */
  phone?: string;
  displayName?: string;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const MAX_EMAIL_LENGTH = 254;

function extractEmail(text: string): string | undefined {
  const match = EMAIL_RE.exec(text);
  if (!match) return undefined;
  const email = match[0].toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH ? email : undefined;
}

/** A run of phone-ish characters: digits with optional +, spaces, dashes, dots, brackets. */
const PHONE_CANDIDATE_RE = /(?<![\w/.-])(\+|00)?[\d][\d\s().-]{6,20}\d(?![\w/-])/g;
/** "call me on", "my number", "whatsapp", "mobile", "phone" shortly before the digits. */
const PHONE_CUE_RE = /(phone|mobile|cell|number|whatsapp|contact|call|reach|tel)\D{0,25}$/i;
const ISO_DATE_RE = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/;
const DMY_DATE_RE = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/;

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/** Returns E.164 when the candidate is convincingly a phone number, otherwise null. */
function toE164(raw: string, hasCue: boolean): string | null {
  const trimmed = raw.trim();
  if (ISO_DATE_RE.test(trimmed) || DMY_DATE_RE.test(trimmed)) return null;

  let digits = digitsOf(trimmed);
  const explicitInternational = trimmed.startsWith('+') || trimmed.startsWith('00');

  if (explicitInternational) {
    if (trimmed.startsWith('00')) digits = digits.slice(2);
  } else if (/^05\d{8}$/.test(digits)) {
    // UAE mobile written locally: 050 123 4567
    digits = `971${digits.slice(1)}`;
  } else if (hasCue && /^5\d{8}$/.test(digits)) {
    digits = `971${digits}`;
  } else if (!hasCue) {
    // Anything else needs an explicit cue ("my number is ...") — a bare digit run is not enough.
    return null;
  }

  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith('0')) return null;
  return `+${digits}`;
}

function extractPhone(text: string): string | undefined {
  for (const match of text.matchAll(PHONE_CANDIDATE_RE)) {
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    const phone = toE164(match[0], PHONE_CUE_RE.test(before));
    if (phone) return phone;
  }
  return undefined;
}

const NAME_RE =
  /\b(?:my name is|my name's|call me|name\s*[:=-])\s+([\p{L}][\p{L}'-]{1,29}(?:\s+[\p{L}][\p{L}'-]{1,29}){0,2})/iu;
/** Words that show the "name" was really the start of another sentence ("call me back"). */
const NOT_A_NAME = new Set([
  'back',
  'later',
  'tomorrow',
  'today',
  'now',
  'soon',
  'on',
  'at',
  'when',
  'please',
  'asap',
  'if',
]);

function extractName(text: string): string | undefined {
  const match = NAME_RE.exec(text);
  if (!match?.[1]) return undefined;
  const words = match[1].split(/\s+/);
  const kept: string[] = [];
  for (const word of words) {
    if (NOT_A_NAME.has(word.toLowerCase())) break;
    kept.push(word);
  }
  if (kept.length === 0) return undefined;
  return kept.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function extractContact(text: string): ExtractedContact {
  const email = extractEmail(text);
  const phone = extractPhone(text);
  const displayName = extractName(text);
  return {
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(displayName ? { displayName } : {}),
  };
}
