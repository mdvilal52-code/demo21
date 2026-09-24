import {
  generate as generateTotp,
  generateSecret,
  generateURI,
  verify as verifyTotp,
} from 'otplib';

/**
 * TOTP (RFC 6238) step-up MFA — MASTER-PLAN.md §6 "step-up/MFA for admin
 * roles". otplib v13's functional API defaults (NobleCryptoPlugin +
 * ScureBase32Plugin, SHA1, 30s step, 6 digits) are the Google-/Microsoft-
 * Authenticator-compatible standard, deliberately left unoverridden.
 */
export function generateTotpSecret(): string {
  return generateSecret();
}

/** `otpauth://` URI an authenticator app scans as a QR code to enroll. */
export function buildTotpEnrollmentUri(params: {
  secret: string;
  accountEmail: string;
  issuer: string;
}): string {
  return generateURI({ issuer: params.issuer, label: params.accountEmail, secret: params.secret });
}

export async function verifyTotpCode(secret: string, code: string): Promise<boolean> {
  try {
    const result = await verifyTotp({ secret, token: code });
    return result.valid;
  } catch {
    return false;
  }
}

/** Generates the current code — test/enrollment-confirmation use only, never a login path. */
export async function generateCurrentTotpCode(secret: string): Promise<string> {
  return generateTotp({ secret });
}
