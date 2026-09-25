import { computeInventoryStatus, FleetProviderError, type FleetProvider } from '@ai-concierge/ai';
import { countOverlappingHolds, type Prisma, type PrismaClient } from '@ai-concierge/db';
import { InventoryStatus, type InventoryStatusValue } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export interface EvaluateInventoryStatusParams {
  tenantId: string;
  vehicleId: string;
  pickupAt: Date;
  returnAt: Date;
  bufferMinutes: number;
  now: Date;
}

export interface InventoryStatusEvaluation {
  status: Exclude<InventoryStatusValue, 'HELD' | 'BOOKED'>;
  source: string;
  reason: string | null;
  retryable: boolean;
}

/**
 * The single place that composes catalog status + fleet capacity + existing
 * reservations into one of AVAILABLE/UNAVAILABLE/MAINTENANCE/UNKNOWN. Used by
 * both `PrismaAvailabilityProvider` (a plain read — `db` is the ordinary
 * `PrismaClient`) and `ReservationLockService.placeHold` (`db` is the
 * transaction client, called *after* the per-vehicle advisory lock is held)
 * — the exact same computation either way, so a preview and the
 * authoritative claim can never silently drift apart on what "available"
 * means. Never a hold-creating side effect itself: `placeHold` is the only
 * thing that inserts a row, based on this function's result.
 */
export async function evaluateInventoryStatus(
  db: Executor,
  fleetProvider: FleetProvider,
  params: EvaluateInventoryStatusParams,
): Promise<InventoryStatusEvaluation> {
  const vehicle = await db.vehicle.findFirst({
    where: { id: params.vehicleId, tenantId: params.tenantId, deletedAt: null },
  });
  if (!vehicle) {
    return {
      status: InventoryStatus.UNAVAILABLE,
      source: 'catalog',
      reason: 'Vehicle not found',
      retryable: false,
    };
  }

  let snapshot;
  try {
    snapshot = await fleetProvider.getInventorySnapshot(params.tenantId, params.vehicleId);
  } catch (error) {
    const message = error instanceof FleetProviderError ? error.message : 'Fleet provider failed';
    const retryable = error instanceof FleetProviderError ? error.retryable : true;
    return {
      status: InventoryStatus.UNKNOWN,
      source: fleetProvider.name,
      reason: message,
      retryable,
    };
  }

  const overlappingCount = await countOverlappingHolds(db, {
    tenantId: params.tenantId,
    vehicleId: params.vehicleId,
    pickupAt: params.pickupAt,
    returnAt: params.returnAt,
    bufferMs: params.bufferMinutes * 60_000,
    now: params.now,
  });

  const status = computeInventoryStatus({
    catalogAvailabilityStatus: vehicle.availabilityStatus,
    catalogActive: vehicle.active,
    activeUnits: snapshot.activeUnits,
    maintenanceUnits: snapshot.maintenanceUnits,
    overlappingCount,
  });

  return { status, source: snapshot.source, reason: null, retryable: false };
}
