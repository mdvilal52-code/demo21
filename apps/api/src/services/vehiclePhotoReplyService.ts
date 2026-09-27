import { listPhotosForVehicles, listVehicles, type PrismaClient } from '@ai-concierge/db';
import type { OutboundAttachment, TenantId } from '@ai-concierge/domain';
import {
  isPhotoRequest,
  matchNamedVehicles,
  wantsWholeFleet,
  type PhotoCatalogEntry,
} from '../lib/photoRequest.js';

/** Photos of one car per reply, and photos in total — keeps a chat message (and a WhatsApp burst) sane. */
const MAX_PHOTOS_PER_CAR = 3;
const MAX_PHOTOS_PER_REPLY = 6;
const MAX_CARS_LISTED = 8;

export interface PhotoReply {
  /** Plain sentence(s) to put in front of the normal journey reply. */
  text: string;
  attachments: OutboundAttachment[];
}

export interface BuildPhotoReplyInput {
  tenantId: TenantId;
  /** The customer's message. */
  message: string;
  /** The car this conversation is already about (Step 3), used for "send me a photo" without a name. */
  resolvedVehicleId: string | null;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

async function loadCatalog(prisma: PrismaClient, tenantId: TenantId): Promise<PhotoCatalogEntry[]> {
  const vehicles = (await listVehicles(prisma, { tenantId, limit: 100, offset: 0 })).filter(
    (vehicle) => vehicle.active,
  );
  const photos = await listPhotosForVehicles(
    prisma,
    tenantId,
    vehicles.map((vehicle) => vehicle.id),
  );
  return vehicles.map((vehicle) => ({
    id: vehicle.id,
    make: vehicle.make,
    model: vehicle.model,
    name: `${vehicle.make} ${vehicle.model}`,
    photos: photos
      .filter((photo) => photo.vehicleId === vehicle.id)
      .map((photo) => ({ id: photo.id, caption: photo.caption })),
  }));
}

/**
 * When a customer asks to see a car, returns the photos staff uploaded for it
 * (or a short honest answer when there are none). Returns null when the
 * message is not a photo request, so the normal journey reply is untouched.
 * Only stored photos are ever attached — never generated or invented.
 */
export async function buildPhotoReply(
  deps: { prisma: PrismaClient },
  input: BuildPhotoReplyInput,
): Promise<PhotoReply | null> {
  if (!isPhotoRequest(input.message)) return null;

  const catalog = await loadCatalog(deps.prisma, input.tenantId);
  if (catalog.length === 0) return null;

  const named = matchNamedVehicles(input.message, catalog);
  let targets: PhotoCatalogEntry[];
  if (named.length > 0) {
    targets = named;
  } else if (wantsWholeFleet(input.message)) {
    targets = catalog.filter((entry) => entry.photos.length > 0);
  } else {
    const current = catalog.find((entry) => entry.id === input.resolvedVehicleId);
    targets = current ? [current] : [];
  }

  if (targets.length === 0) {
    const listed = catalog.slice(0, MAX_CARS_LISTED).map((entry) => entry.name);
    return {
      text: `Which car would you like to see? We currently offer the ${joinNames(listed)}.`,
      attachments: [],
    };
  }

  const attachments: OutboundAttachment[] = [];
  const shown: string[] = [];
  const withoutPhotos: string[] = [];
  for (const entry of targets) {
    if (entry.photos.length === 0) {
      withoutPhotos.push(entry.name);
      continue;
    }
    let added = 0;
    for (const photo of entry.photos) {
      if (added >= MAX_PHOTOS_PER_CAR || attachments.length >= MAX_PHOTOS_PER_REPLY) break;
      attachments.push({
        photoId: photo.id,
        vehicleId: entry.id,
        caption: (photo.caption ? `${entry.name} - ${photo.caption}` : entry.name).slice(0, 200),
      });
      added += 1;
    }
    if (added > 0) shown.push(entry.name);
  }

  const parts: string[] = [];
  if (shown.length > 0) parts.push(`Here are photos of the ${joinNames(shown)}.`);
  if (withoutPhotos.length > 0) {
    parts.push(
      `I do not have photos of the ${joinNames(withoutPhotos)} to hand yet, but our team can share some with you.`,
    );
  }
  return { text: parts.join(' '), attachments };
}
