import { z } from 'zod';

export const livenessResponseSchema = z.object({
  status: z.literal('alive'),
  uptimeSeconds: z.number().nonnegative(),
});
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

export const dependencyStatusSchema = z.enum(['up', 'down']);

export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  dependencies: z.object({
    database: dependencyStatusSchema,
    redis: dependencyStatusSchema,
  }),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  observability: z.enum(['CONFIGURED', 'NOT_CONFIGURED']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
