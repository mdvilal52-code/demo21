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
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),

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
