import type { VehicleAlternativeCriteria, VehicleCatalogProvider } from '@ai-concierge/ai';
import {
  findAlternativeVehicles,
  findVehiclesByIds,
  listVehicleLexicon,
  type PrismaClient,
} from '@ai-concierge/db';

/**
 * The concrete, Prisma-backed implementation of `packages/ai`'s
 * `VehicleCatalogProvider` seam — lives here (the composition root that
 * already depends on both `@ai-concierge/ai` and `@ai-concierge/db`) rather
 * than in either package, keeping `packages/ai` free of any DB dependency
 * (mirrors Step 2's `LocationProvider` layering, except this provider is
 * genuinely tenant-scoped, so every method takes tenantId per call instead
 * of it being fixed at construction time).
 */
export class PrismaVehicleCatalogProvider implements VehicleCatalogProvider {
  readonly name = 'prisma-vehicle-catalog';

  constructor(private readonly prisma: PrismaClient) {}

  async listLexicon(tenantId: string) {
    return listVehicleLexicon(this.prisma, tenantId);
  }

  async findByIds(tenantId: string, ids: string[]) {
    return findVehiclesByIds(this.prisma, tenantId, ids);
  }

  async findAlternatives(tenantId: string, criteria: VehicleAlternativeCriteria) {
    return findAlternativeVehicles(this.prisma, tenantId, criteria);
  }
}
