'use server';

import { revalidatePath } from 'next/cache';
import { createVehicleBodySchema, updateVehicleBodySchema } from '@ai-concierge/contracts';
import {
  SessionExpiredError,
  createFleetVehicle,
  deleteVehiclePhoto,
  updateFleetVehicle,
} from '../../../lib/adminApi';
import type { FleetFormState } from './fleetState';

const FLEET_PATH = '/dashboard/fleet';

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Empty box -> undefined; anything else -> a number (validated by the shared schema). */
function optionalNumber(formData: FormData, name: string): number | undefined {
  const raw = text(formData, name);
  return raw === '' ? undefined : Number(raw);
}

function failure(error: unknown, nonce: number): FleetFormState {
  if (error instanceof SessionExpiredError) {
    return { status: 'error', message: 'Your session expired. Sign in again.', nonce };
  }
  return {
    status: 'error',
    message: error instanceof Error ? error.message : 'Something went wrong. Try again.',
    nonce,
  };
}

/** Adds a car to the catalog. The API enforces fleet:write; this only validates the shape first. */
export async function createVehicleAction(
  previous: FleetFormState,
  formData: FormData,
): Promise<FleetFormState> {
  const nonce = previous.nonce + 1;
  const parsed = createVehicleBodySchema.safeParse({
    make: text(formData, 'make'),
    model: text(formData, 'model'),
    category: text(formData, 'category'),
    luxuryTier: text(formData, 'luxuryTier'),
    seats: Number(text(formData, 'seats')),
    luggage: Number(text(formData, 'luggage')),
    transmission: text(formData, 'transmission'),
    dailyRate: Number(text(formData, 'dailyRate')),
    depositAmount: optionalNumber(formData, 'depositAmount'),
    units: Number(text(formData, 'units') || '1'),
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      status: 'error',
      message: first ? `${first.path.join('.') || 'Form'}: ${first.message}` : 'Check the form.',
      nonce,
    };
  }
  try {
    const { vehicle } = await createFleetVehicle(parsed.data);
    revalidatePath(FLEET_PATH);
    return {
      status: 'success',
      message: `${vehicle.make} ${vehicle.model} added. Now upload its photos below.`,
      nonce,
    };
  } catch (error) {
    return failure(error, nonce);
  }
}

/** Saves a car's daily rate, availability and active flag. */
export async function updateVehicleAction(
  vehicleId: string,
  previous: FleetFormState,
  formData: FormData,
): Promise<FleetFormState> {
  const nonce = previous.nonce + 1;
  const parsed = updateVehicleBodySchema.safeParse({
    dailyRate: Number(text(formData, 'dailyRate')),
    availabilityStatus: text(formData, 'availabilityStatus'),
    active: formData.get('active') === 'on',
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      status: 'error',
      message: first ? `${first.path.join('.') || 'Form'}: ${first.message}` : 'Check the form.',
      nonce,
    };
  }
  try {
    await updateFleetVehicle(vehicleId, parsed.data);
    revalidatePath(FLEET_PATH);
    return { status: 'success', message: 'Saved.', nonce };
  } catch (error) {
    return failure(error, nonce);
  }
}

export async function deletePhotoAction(photoId: string): Promise<void> {
  await deleteVehiclePhoto(photoId);
  revalidatePath(FLEET_PATH);
}
