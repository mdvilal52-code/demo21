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

  // Meta WhatsApp Cloud API — all four optional so the API boots with the
  // adapter NOT_CONFIGURED until every one of them is set (see
  // lib/whatsappClient.ts). Never all required: a partial set is still
  // NOT_CONFIGURED, not a startup failure.
  // .trim() on all four: a stray newline/space from copying out of the Meta
  // App Dashboard or a platform's env var text box changes the bytes used
  // for HMAC signing/verification and the Bearer token sent to Graph API,
  // while still reading as "set" — a signature check that fails on every
  // single request (never intermittently) is this class of bug.
  WHATSAPP_ACCESS_TOKEN: z.string().trim().min(1).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().trim().min(1).optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().trim().min(1).optional(),
  WHATSAPP_APP_SECRET: z.string().trim().min(1).optional(),
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
