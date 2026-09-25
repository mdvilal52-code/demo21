import type {
  AvailabilityCheckOutcome,
  AvailabilityCheckQuery,
  AvailabilityProvider,
  FleetProvider,
} from '@ai-concierge/ai';
import type { PrismaClient } from '@ai-concierge/db';
import { evaluateInventoryStatus } from './inventoryStatusEvaluator.js';

export interface PrismaAvailabilityProviderOptions {
  bufferMinutes: number;
}

/**
 * The concrete, Prisma-backed implementation of `packages/ai`'s
 * `AvailabilityProvider` seam — lives here (the composition root that
 * already depends on both `@ai-concierge/ai` and `@ai-concierge/db`), same
 * layering as `PrismaVehicleCatalogProvider`. A non-committal read, sharing
 * `evaluateInventoryStatus` with `ReservationLockService.placeHold` so the
 * two can never silently compute "available" differently — but this class
 * takes no lock and creates no hold; see this class's own interface doc for
 * why its result may never be surfaced as a guarantee.
 */
export class PrismaAvailabilityProvider implements AvailabilityProvider {
  readonly name = 'prisma-availability';

  constructor(
    private readonly prisma: PrismaClient,
    private readonly fleetProvider: FleetProvider,
    private readonly options: PrismaAvailabilityProviderOptions,
  ) {}

  async checkAvailability(query: AvailabilityCheckQuery): Promise<AvailabilityCheckOutcome> {
    return evaluateInventoryStatus(this.prisma, this.fleetProvider, {
      tenantId: query.tenantId,
      vehicleId: query.vehicleId,
      pickupAt: query.pickupAt,
      returnAt: query.returnAt,
      bufferMinutes: this.options.bufferMinutes,
      now: new Date(),
    });
  }
}
