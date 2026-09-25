import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@ai-concierge/config';

export const workerEnvSchema = baseEnvSchema.extend({
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  // Phase 6 — how often the housekeeping sweep flips lapsed ACTIVE holds to
  // EXPIRED. Never load-bearing for correctness (see holdExpirationSweep.ts).
  HOLD_EXPIRATION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  // How often the housekeeping sweep flags OPEN/IN_PROGRESS EscalationCases
  // past their SLA due date. Never load-bearing for correctness — same
  // "housekeeping only, self-heals" posture as the hold-expiration sweep.
  ESCALATION_SLA_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return loadEnv(workerEnvSchema, source);
}
