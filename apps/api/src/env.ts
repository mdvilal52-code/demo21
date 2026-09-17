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
