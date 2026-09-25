import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@ai-concierge/config';

export const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  API_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(102_400),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // WhatsApp (Meta Cloud API) — all optional. Any left unset means the
  // channel reports NOT_CONFIGURED rather than faking a working integration.
  // .trim() on every secret/token/id below: a stray newline or space picked
  // up when copying a value out of the Meta App Dashboard or pasting into a
  // platform's env var text box still reads as "set", but changes every
  // HMAC computed from it — a webhook signature check that fails on every
  // single request (never intermittently, always the same bytes wrong) is
  // this exact class of bug, not a code defect in the verifier itself.
  // WHATSAPP_VERIFY_TOKEN: a value you invent yourself and paste into Meta's
  // "Verify token" field when you register this webhook URL.
  WHATSAPP_VERIFY_TOKEN: z.string().trim().min(1).optional(),
  // WHATSAPP_APP_SECRET: from your Meta App's Basic Settings — used to
  // verify the X-Hub-Signature-256 header on every inbound webhook.
  WHATSAPP_APP_SECRET: z.string().trim().min(16).optional(),
  // WHATSAPP_ACCESS_TOKEN: a permanent token for the WhatsApp Business
  // Account (System User token recommended over the 24h test token).
  WHATSAPP_ACCESS_TOKEN: z.string().trim().min(1).optional(),
  // WHATSAPP_PHONE_NUMBER_ID: the "Phone number ID" (not the phone number
  // itself) from Meta's WhatsApp > API Setup page.
  WHATSAPP_PHONE_NUMBER_ID: z.string().trim().min(1).optional(),
  WHATSAPP_API_VERSION: z.string().trim().min(1).default('v21.0'),

  // Phase 6 — Availability. FLEET_PROVIDER selects the FleetProvider
  // implementation; 'database' (default) is real, DB-backed inventory
  // (VehicleUnit rows) and always works with zero configuration. 'external'
  // opts into a third-party fleet-management API and requires
  // FLEET_API_BASE_URL/FLEET_API_KEY — left unset, it reports NOT_CONFIGURED
  // rather than faking a working integration (same convention as WhatsApp).
  FLEET_PROVIDER: z.enum(['database', 'external']).default('database'),
  FLEET_API_BASE_URL: z.string().trim().url().optional(),
  FLEET_API_KEY: z.string().trim().min(1).optional(),
  FLEET_API_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  // How long a temporary hold survives before it lapses back to available capacity.
  AVAILABILITY_HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Turnaround buffer applied to both ends of an overlap check (cleaning/inspection window).
  AVAILABILITY_TURNAROUND_BUFFER_MINUTES: z.coerce.number().int().nonnegative().default(120),

  // Phase 6 — AuthN/AuthZ. Required (unlike the provider seams above): every
  // environment that boots the API issues/verifies its own staff sessions,
  // there is no NOT_CONFIGURED state for "nobody can log in".
  JWT_SIGNING_SECRET: z.string().min(32),
  MFA_ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
    message:
      'MFA_ENCRYPTION_KEY must be base64 for exactly 32 bytes (AES-256) — see generateEncryptionKey()',
  }),
  AUTH_TOKEN_ISSUER: z.string().default('AI Concierge'),
  // Stricter than RATE_LIMIT_MAX/_WINDOW_MS above — brute-force protection
  // scoped to /v1/auth/login specifically (see plugins/security.ts).
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // Gemini — conversational reply generation only (Steps 1-4's business
  // facts stay deterministic regardless). Only the API key gates
  // CONFIGURED/NOT_CONFIGURED; the rest are tuning knobs with safe defaults,
  // not credentials (see lib/geminiProvider.ts).
  GEMINI_API_KEY: z.string().min(1).optional(),
  // No plain "gemini-3.1-flash" GA id exists as of this writing — see
  // docs/phases/PHASE-06.md §2. Override freely once you've confirmed what
  // your own API key/tier has access to; nothing else in the code changes.
  GEMINI_MODEL_ID: z.string().min(1).default('gemini-3.8-flash'),
  GEMINI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.6),
  GEMINI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(512),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  // Most PaaS providers (Render, Heroku, ...) assign the port to listen on
  // via the platform-standard `PORT` variable, not our own `API_PORT`. Adopt
  // it only when `API_PORT` wasn't set explicitly, so local/dev behavior
  // (which never sets `PORT`) is unaffected.
  const normalized =
    !source.API_PORT && source.PORT ? { ...source, API_PORT: source.PORT } : source;
  return loadEnv(apiEnvSchema, normalized);
}
