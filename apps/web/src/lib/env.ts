import 'server-only';
import { z } from 'zod';

const serverEnvSchema = z.object({
  INTERNAL_API_BASE_URL: z.string().url().default('http://localhost:4000'),
  OUTBOUND_ALLOWED_HOSTS: z
    .string()
    .default('localhost,127.0.0.1')
    .transform((value) =>
      value
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
});

export function loadServerEnv() {
  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid web server environment: ${result.error.message}`);
  }
  return result.data;
}
