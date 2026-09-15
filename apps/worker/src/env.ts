import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@ai-concierge/config';

export const workerEnvSchema = baseEnvSchema.extend({
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return loadEnv(workerEnvSchema, source);
}
