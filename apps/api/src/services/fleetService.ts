import { randomUUID } from 'node:crypto';
import {
  MAX_PHOTOS_PER_VEHICLE,
  PrismaAuditWriter,
  countVehiclePhotos,
  createVehicle,
  createVehiclePhoto,
  createVehicleUnit,
  deleteVehiclePhoto,
  findVehiclesByIds,
  listPhotosForVehicles,
  listVehicles,
  normalizeVehicleName,
  updateVehicle,
  type PrismaClient,
  type VehiclePhotoRecord,
} from '@ai-concierge/db';
import {
  MAX_VEHICLE_PHOTO_BYTES,
  type CreateVehicleBody,
  type FleetVehicle,
  type UpdateVehicleBody,
  type VehiclePhoto,
} from '@ai-concierge/contracts';
import { AppError, type TenantId, type Vehicle } from '@ai-concierge/domain';
import { sniffImageType, storageKeyFor, type MediaStorage } from '../lib/mediaStorage.js';

export interface FleetServiceDeps {
  prisma: PrismaClient;
  storage: MediaStorage;
  /** API_PUBLIC_URL — photo URLs are absolute so the website and emails can show them. */
  publicBaseUrl: string;
}

export function photoPublicUrl(publicBaseUrl: string, photoId: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/media/vehicles/${photoId}`;
}

export function toVehiclePhoto(publicBaseUrl: string, row: VehiclePhotoRecord): VehiclePhoto {
  return {
    id: row.id,
    vehicleId: row.vehicleId,
    url: photoPublicUrl(publicBaseUrl, row.id),
    contentType: row.contentType as VehiclePhoto['contentType'],
    sizeBytes: row.sizeBytes,
    caption: row.caption,
    sortOrder: row.sortOrder,
  };
}

async function withPhotos(
  deps: FleetServiceDeps,
  tenantId: TenantId,
  vehicles: Vehicle[],
): Promise<FleetVehicle[]> {
  const photos = await listPhotosForVehicles(
    deps.prisma,
    tenantId,
    vehicles.map((vehicle) => vehicle.id),
  );
  return vehicles.map((vehicle) => ({
    ...vehicle,
    photos: photos
      .filter((photo) => photo.vehicleId === vehicle.id)
      .map((photo) => toVehiclePhoto(deps.publicBaseUrl, photo)),
  }));
}

export async function listFleet(
  deps: FleetServiceDeps,
  input: { tenantId: TenantId; limit: number; offset: number },
): Promise<FleetVehicle[]> {
  const vehicles = await listVehicles(deps.prisma, input);
  return withPhotos(deps, input.tenantId, vehicles);
}

async function getFleetVehicle(
  deps: FleetServiceDeps,
  tenantId: TenantId,
  vehicleId: string,
): Promise<FleetVehicle> {
  const [vehicle] = await findVehiclesByIds(deps.prisma, tenantId, [vehicleId]);
  if (!vehicle) throw new AppError('NOT_FOUND', 'Vehicle not found');
  const [withPhoto] = await withPhotos(deps, tenantId, [vehicle]);
  return withPhoto!;
}

export interface FleetActor {
  tenantId: TenantId;
  userId: string;
  requestId: string;
}

function audit(
  deps: FleetServiceDeps,
  actor: FleetActor,
  action: string,
  entityId: string,
  after: Record<string, unknown>,
): Promise<void> {
  return new PrismaAuditWriter(deps.prisma).record({
    tenantId: actor.tenantId,
    actor: `user:${actor.userId}`,
    action,
    entityType: 'Vehicle',
    entityId,
    after,
    requestId: actor.requestId,
  });
}

/** "Toyota Camry" -> unit refs TOYOTA-CAMRY-01, -02 ... (unique per vehicle). */
function unitRefs(make: string, model: string, count: number): string[] {
  const base = `${make}-${model}`
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return Array.from(
    { length: count },
    (_, index) => `${base}-${String(index + 1).padStart(2, '0')}`,
  );
}

/** Adds a car to the catalog together with the physical units the availability check counts. */
export async function createFleetVehicle(
  deps: FleetServiceDeps,
  actor: FleetActor,
  body: CreateVehicleBody,
): Promise<FleetVehicle> {
  const make = normalizeVehicleName(body.make);
  const model = normalizeVehicleName(body.model);
  const vehicle = await deps.prisma.$transaction(async (tx) => {
    const created = await createVehicle(tx, {
      tenantId: actor.tenantId,
      make,
      model,
      category: body.category,
      luxuryTier: body.luxuryTier,
      seats: body.seats,
      luggage: body.luggage,
      transmission: body.transmission,
      pricingProfile: {
        currency: 'AED',
        dailyRate: body.dailyRate,
        ...(body.depositAmount !== undefined ? { depositAmount: body.depositAmount } : {}),
      },
    });
    for (const unitRef of unitRefs(make, model, body.units)) {
      await createVehicleUnit(tx, { tenantId: actor.tenantId, vehicleId: created.id, unitRef });
    }
    return created;
  });
  await audit(deps, actor, 'fleet.vehicle_created', vehicle.id, {
    make,
    model,
    units: body.units,
    dailyRate: body.dailyRate,
  });
  return getFleetVehicle(deps, actor.tenantId, vehicle.id);
}

export async function updateFleetVehicle(
  deps: FleetServiceDeps,
  actor: FleetActor,
  vehicleId: string,
  body: UpdateVehicleBody,
): Promise<FleetVehicle> {
  const [existing] = await findVehiclesByIds(deps.prisma, actor.tenantId, [vehicleId]);
  if (!existing) throw new AppError('NOT_FOUND', 'Vehicle not found');
  const { dailyRate, depositAmount, ...rest } = body;
  const pricingProfile =
    dailyRate !== undefined || depositAmount !== undefined
      ? {
          ...existing.pricingProfile,
          ...(dailyRate !== undefined ? { dailyRate } : {}),
          ...(depositAmount !== undefined ? { depositAmount } : {}),
        }
      : undefined;
  const updated = await updateVehicle(deps.prisma, actor.tenantId, vehicleId, {
    ...rest,
    ...(pricingProfile ? { pricingProfile } : {}),
  });
  if (!updated) throw new AppError('NOT_FOUND', 'Vehicle not found');
  await audit(deps, actor, 'fleet.vehicle_updated', vehicleId, { fields: Object.keys(body) });
  return getFleetVehicle(deps, actor.tenantId, vehicleId);
}

export interface AddVehiclePhotoInput {
  vehicleId: string;
  bytes: Buffer;
  caption?: string | undefined;
}

/**
 * Stores one photo for a car. The image type comes from the bytes (never the
 * claimed Content-Type); the file is written first and removed again if the
 * database insert fails, so a failed upload never leaves an orphan behind.
 */
export async function addVehiclePhoto(
  deps: FleetServiceDeps,
  actor: FleetActor,
  input: AddVehiclePhotoInput,
): Promise<VehiclePhoto> {
  if (input.bytes.length === 0) throw new AppError('VALIDATION_FAILED', 'The photo is empty');
  if (input.bytes.length > MAX_VEHICLE_PHOTO_BYTES) {
    throw new AppError('VALIDATION_FAILED', 'The photo is too large (4 MB maximum)');
  }
  const type = sniffImageType(input.bytes);
  if (!type) {
    throw new AppError('VALIDATION_FAILED', 'Only JPEG, PNG or WebP photos are accepted');
  }
  const [vehicle] = await findVehiclesByIds(deps.prisma, actor.tenantId, [input.vehicleId]);
  if (!vehicle) throw new AppError('NOT_FOUND', 'Vehicle not found');
  const existing = await countVehiclePhotos(deps.prisma, actor.tenantId, vehicle.id);
  if (existing >= MAX_PHOTOS_PER_VEHICLE) {
    throw new AppError('CONFLICT', `A car can have at most ${MAX_PHOTOS_PER_VEHICLE} photos`);
  }

  const id = randomUUID();
  const storageKey = storageKeyFor(id, type);
  await deps.storage.save(storageKey, input.bytes);
  try {
    const row = await createVehiclePhoto(deps.prisma, {
      id,
      tenantId: actor.tenantId,
      vehicleId: vehicle.id,
      storageKey,
      contentType: type,
      sizeBytes: input.bytes.length,
      caption: input.caption ?? null,
    });
    await audit(deps, actor, 'fleet.photo_added', vehicle.id, {
      photoId: id,
      sizeBytes: row.sizeBytes,
    });
    return toVehiclePhoto(deps.publicBaseUrl, row);
  } catch (error) {
    await deps.storage.remove(storageKey).catch(() => undefined);
    throw error;
  }
}

export async function removeVehiclePhoto(
  deps: FleetServiceDeps,
  actor: FleetActor,
  photoId: string,
): Promise<void> {
  const row = await deleteVehiclePhoto(deps.prisma, actor.tenantId, photoId);
  if (!row) throw new AppError('NOT_FOUND', 'Photo not found');
  await deps.storage.remove(row.storageKey).catch(() => undefined);
  await audit(deps, actor, 'fleet.photo_removed', row.vehicleId, { photoId });
}
