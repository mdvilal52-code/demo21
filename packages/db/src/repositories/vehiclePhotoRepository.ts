import type { Prisma, PrismaClient } from '@prisma/client';
import type { TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

/** How many photos one vehicle may carry — keeps a chat reply (and the disk) bounded. */
export const MAX_PHOTOS_PER_VEHICLE = 8;

export interface VehiclePhotoRecord {
  id: string;
  vehicleId: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  caption: string | null;
  sortOrder: number;
  createdAt: Date;
}

const photoSelect = {
  id: true,
  vehicleId: true,
  storageKey: true,
  contentType: true,
  sizeBytes: true,
  caption: true,
  sortOrder: true,
  createdAt: true,
} as const;

export interface CreateVehiclePhotoInput {
  id: string;
  tenantId: TenantId;
  vehicleId: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  caption?: string | null;
}

/** Appends at the end of the vehicle's gallery (the first photo is the one customers see first). */
export async function createVehiclePhoto(
  db: Executor,
  input: CreateVehiclePhotoInput,
): Promise<VehiclePhotoRecord> {
  const last = await db.vehiclePhoto.findFirst({
    where: { tenantId: input.tenantId, vehicleId: input.vehicleId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  return db.vehiclePhoto.create({
    data: {
      id: input.id,
      tenantId: input.tenantId,
      vehicleId: input.vehicleId,
      storageKey: input.storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      caption: input.caption ?? null,
      sortOrder: last ? last.sortOrder + 1 : 0,
    },
    select: photoSelect,
  });
}

export async function countVehiclePhotos(
  db: Executor,
  tenantId: TenantId,
  vehicleId: string,
): Promise<number> {
  return db.vehiclePhoto.count({ where: { tenantId, vehicleId } });
}

/** Every photo of the given vehicles, gallery order (oldest sortOrder first). */
export async function listPhotosForVehicles(
  db: Executor,
  tenantId: TenantId,
  vehicleIds: string[],
): Promise<VehiclePhotoRecord[]> {
  if (vehicleIds.length === 0) return [];
  return db.vehiclePhoto.findMany({
    where: { tenantId, vehicleId: { in: vehicleIds } },
    orderBy: [{ vehicleId: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: photoSelect,
  });
}

export async function findVehiclePhoto(
  db: Executor,
  tenantId: TenantId,
  id: string,
): Promise<VehiclePhotoRecord | null> {
  return db.vehiclePhoto.findFirst({ where: { id, tenantId }, select: photoSelect });
}

/** Returns the deleted row (so the caller can remove the file), or null if it was already gone. */
export async function deleteVehiclePhoto(
  db: Executor,
  tenantId: TenantId,
  id: string,
): Promise<VehiclePhotoRecord | null> {
  const existing = await findVehiclePhoto(db, tenantId, id);
  if (!existing) return null;
  await db.vehiclePhoto.deleteMany({ where: { id, tenantId } });
  return existing;
}
