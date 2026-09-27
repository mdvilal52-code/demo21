import { z } from 'zod';
import {
  luxuryTierSchema,
  transmissionSchema,
  vehicleAvailabilityStatusSchema,
  vehicleCategorySchema,
  vehicleSchema,
} from '@ai-concierge/domain';

/**
 * Fleet management from the dashboard: list a car (name + specs + daily rate)
 * and its photos. When a customer asks the concierge to see a car, these
 * photos are what it sends back.
 */

/** A photo as the dashboard and the chat see it: a public, unguessable URL, never a file path. */
export const vehiclePhotoSchema = z.object({
  id: z.string().uuid(),
  vehicleId: z.string().uuid(),
  url: z.string().url(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().positive(),
  caption: z.string().nullable(),
  sortOrder: z.number().int().nonnegative(),
});
export type VehiclePhoto = z.infer<typeof vehiclePhotoSchema>;

export const fleetVehicleSchema = vehicleSchema.extend({ photos: z.array(vehiclePhotoSchema) });
export type FleetVehicle = z.infer<typeof fleetVehicleSchema>;

const carNamePart = z
  .string()
  .trim()
  .min(1)
  .max(60)
  // Letters/digits and the punctuation real model names use — no markup, no control chars.
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} .\-+/]*$/u, 'Use letters, numbers, spaces, - . + / only');

const dailyRate = z.number().positive().max(1_000_000);

export const createVehicleBodySchema = z
  .object({
    make: carNamePart,
    model: carNamePart,
    category: vehicleCategorySchema,
    luxuryTier: luxuryTierSchema,
    seats: z.number().int().min(1).max(20),
    luggage: z.number().int().min(0).max(20),
    transmission: transmissionSchema,
    /** AED per day. */
    dailyRate,
    depositAmount: z.number().nonnegative().max(1_000_000).optional(),
    /** How many physical cars of this model can be rented at once (drives availability). */
    units: z.number().int().min(1).max(50).default(1),
  })
  .strict();
export type CreateVehicleBody = z.infer<typeof createVehicleBodySchema>;

export const updateVehicleBodySchema = z
  .object({
    category: vehicleCategorySchema.optional(),
    luxuryTier: luxuryTierSchema.optional(),
    seats: z.number().int().min(1).max(20).optional(),
    luggage: z.number().int().min(0).max(20).optional(),
    transmission: transmissionSchema.optional(),
    availabilityStatus: vehicleAvailabilityStatusSchema.optional(),
    active: z.boolean().optional(),
    dailyRate: dailyRate.optional(),
    depositAmount: z.number().nonnegative().max(1_000_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');
export type UpdateVehicleBody = z.infer<typeof updateVehicleBodySchema>;

export const vehicleIdParamsSchema = z.object({ vehicleId: z.string().uuid() });
export const vehiclePhotoIdParamsSchema = z.object({ photoId: z.string().uuid() });

export const uploadVehiclePhotoQuerySchema = z.object({
  caption: z.string().trim().min(1).max(120).optional(),
});
export type UploadVehiclePhotoQuery = z.infer<typeof uploadVehiclePhotoQuerySchema>;

export const fleetVehicleResponseSchema = z.object({ vehicle: fleetVehicleSchema });
export type FleetVehicleResponse = z.infer<typeof fleetVehicleResponseSchema>;

export const vehiclePhotoResponseSchema = z.object({ photo: vehiclePhotoSchema });
export type VehiclePhotoResponse = z.infer<typeof vehiclePhotoResponseSchema>;

export const deleteVehiclePhotoResponseSchema = z.object({ deleted: z.literal(true) });

/** Largest photo the API accepts (the dashboard shrinks bigger ones in the browser first). */
export const MAX_VEHICLE_PHOTO_BYTES = 4_000_000;
export const ALLOWED_VEHICLE_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
