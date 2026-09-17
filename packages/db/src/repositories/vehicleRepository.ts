import { Prisma, type PrismaClient, type Vehicle as PrismaVehicle } from '@prisma/client';
import {
  AppError,
  vehicleSchema,
  type PricingProfile,
  type TenantId,
  type Vehicle,
} from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

/**
 * Maps a Prisma row to the public domain shape (drops tenantId/deletedAt/
 * timestamps) and re-validates via Zod — cheap insurance against a stored
 * `pricingProfile` JSON column drifting out of shape after a future schema
 * change, the same "never trust it just because it's our own DB" posture
 * applied to reads.
 */
export function toDomainVehicle(row: PrismaVehicle): Vehicle {
  return vehicleSchema.parse({
    id: row.id,
    make: row.make,
    model: row.model,
    category: row.category,
    luxuryTier: row.luxuryTier,
    seats: row.seats,
    luggage: row.luggage,
    transmission: row.transmission,
    availabilityStatus: row.availabilityStatus,
    pricingProfile: row.pricingProfile,
    active: row.active,
  });
}

/**
 * Title-cases each word so "lamborghini", "Lamborghini" and "LAMBORGHINI"
 * all collide on the `(tenantId, make, model)` unique constraint — avoids
 * needing the `citext` extension for a case-insensitive identity check.
 */
export function normalizeVehicleName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export interface CreateVehicleInput {
  tenantId: TenantId;
  make: string;
  model: string;
  category: string;
  luxuryTier: string;
  seats: number;
  luggage: number;
  transmission: string;
  availabilityStatus?: string;
  pricingProfile: PricingProfile;
  active?: boolean;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Every query below excludes `deletedAt` rows — a soft-deleted vehicle behaves as if it never existed. */
export async function createVehicle(db: Executor, input: CreateVehicleInput) {
  const make = normalizeVehicleName(input.make);
  const model = normalizeVehicleName(input.model);
  try {
    return await db.vehicle.create({
      data: {
        tenantId: input.tenantId,
        make,
        model,
        category: input.category as Prisma.VehicleCreateInput['category'],
        luxuryTier: input.luxuryTier as Prisma.VehicleCreateInput['luxuryTier'],
        seats: input.seats,
        luggage: input.luggage,
        transmission: input.transmission as Prisma.VehicleCreateInput['transmission'],
        availabilityStatus:
          input.availabilityStatus as Prisma.VehicleCreateInput['availabilityStatus'],
        pricingProfile: input.pricingProfile as unknown as Prisma.InputJsonValue,
        active: input.active,
      },
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new AppError('CONFLICT', `Vehicle "${make} ${model}" already exists for this tenant`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** Sets `deletedAt` and `active=false` instead of a real DELETE; idempotent (0 rows if already gone). */
export async function softDeleteVehicle(db: Executor, tenantId: TenantId, vehicleId: string) {
  return db.vehicle.updateMany({
    where: { id: vehicleId, tenantId, deletedAt: null },
    data: { deletedAt: new Date(), active: false },
  });
}

/**
 * Lightweight projection for `VehicleIntentService`'s matching lexicon.
 * Deliberately includes inactive/unavailable vehicles (so a customer naming
 * one gets a specific "it's inactive" answer, not a generic "unknown
 * vehicle") but never soft-deleted ones (those behave as if they never
 * existed at all).
 */
export async function listVehicleLexicon(db: Executor, tenantId: TenantId) {
  return db.vehicle.findMany({
    where: { tenantId, deletedAt: null },
    select: {
      id: true,
      make: true,
      model: true,
      category: true,
      active: true,
      availabilityStatus: true,
    },
  });
}

export async function findVehiclesByIds(
  db: Executor,
  tenantId: TenantId,
  ids: string[],
): Promise<Vehicle[]> {
  if (ids.length === 0) return [];
  const rows = await db.vehicle.findMany({ where: { tenantId, id: { in: ids }, deletedAt: null } });
  return rows.map(toDomainVehicle);
}

export interface AlternativeVehicleCriteria {
  category?: string;
  excludeIds?: string[];
  limit?: number;
}

/** Only ever suggests vehicles that are genuinely bookable right now (active + AVAILABLE). */
export async function findAlternativeVehicles(
  db: Executor,
  tenantId: TenantId,
  criteria: AlternativeVehicleCriteria = {},
): Promise<Vehicle[]> {
  const rows = await db.vehicle.findMany({
    where: {
      tenantId,
      deletedAt: null,
      active: true,
      availabilityStatus: 'AVAILABLE',
      ...(criteria.category
        ? { category: criteria.category as Prisma.VehicleWhereInput['category'] }
        : {}),
      ...(criteria.excludeIds && criteria.excludeIds.length > 0
        ? { id: { notIn: criteria.excludeIds } }
        : {}),
    },
    take: criteria.limit ?? 5,
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toDomainVehicle);
}
