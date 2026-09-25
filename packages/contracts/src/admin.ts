import { z } from 'zod';
import {
  customerSchema,
  customerTimelineEventSchema,
  journeySchema,
  journeyStateSchema,
  vehicleSchema,
} from '@ai-concierge/domain';

export const listJourneysQuerySchema = z.object({
  state: journeyStateSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type ListJourneysQuery = z.infer<typeof listJourneysQuerySchema>;

export const listJourneysResponseSchema = z.object({ items: z.array(journeySchema) });
export type ListJourneysResponse = z.infer<typeof listJourneysResponseSchema>;

export const listVehiclesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type ListVehiclesQuery = z.infer<typeof listVehiclesQuerySchema>;

export const listVehiclesResponseSchema = z.object({ items: z.array(vehicleSchema) });
export type ListVehiclesResponse = z.infer<typeof listVehiclesResponseSchema>;

export const listCustomersQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

export const listCustomersResponseSchema = z.object({ items: z.array(customerSchema) });
export type ListCustomersResponse = z.infer<typeof listCustomersResponseSchema>;

export const getCustomerParamsSchema = z.object({ customerId: z.string().uuid() });
export type GetCustomerParams = z.infer<typeof getCustomerParamsSchema>;

export const getCustomerResponseSchema = z.object({
  customer: customerSchema,
  timeline: z.array(customerTimelineEventSchema),
});
export type GetCustomerResponse = z.infer<typeof getCustomerResponseSchema>;

const providerStatusValueSchema = z.enum(['CONFIGURED', 'NOT_CONFIGURED']);

/** MASTER-PLAN.md §1's admin Settings contract: "provider status CONFIGURED / NOT_CONFIGURED" — never a fake status. */
export const providerStatusResponseSchema = z.object({
  whatsapp: providerStatusValueSchema,
  email: providerStatusValueSchema,
  smsNotification: providerStatusValueSchema,
  conversationalAi: providerStatusValueSchema,
  observability: providerStatusValueSchema,
});
export type ProviderStatusResponse = z.infer<typeof providerStatusResponseSchema>;
