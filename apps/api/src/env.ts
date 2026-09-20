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
