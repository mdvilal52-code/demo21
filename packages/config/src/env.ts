import { z } from 'zod';

/**
 * Base environment shared by every process (api, worker, web server-side).
 * Each app extends this with its own required variables and calls
 * `loadEnv` with its extended schema — never reads `process.env` directly.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Comma-separated hostnames outbound requests are allowed to reach (SSRF protection).
  OUTBOUND_ALLOWED_HOSTS: z
    .string()
    .default('localhost,127.0.0.1')
    .transform((value) =>
      value
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),

  // .trim(): a trailing newline/space from a dashboard paste or a .env file
  // is invisible in most UIs but changes every HMAC computed from this
  // value, so it silently breaks all signature verification while the
  // "is it set" check still passes.
  WEBHOOK_SIGNING_SECRET: z.string().trim().min(16),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional().or(z.literal('')),
  OTEL_SERVICE_NAME: z.string().default('ai-concierge'),

  DEFAULT_TENANT_ID: z.string().uuid(),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * Fails fast with a readable message instead of letting an invalid config
 * reach production code paths. Called once at process startup.
 */
export function loadEnv<Schema extends typeof baseEnvSchema>(
  schema: Schema,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<Schema> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
