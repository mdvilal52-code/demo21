import type { Prisma, PrismaClient } from '@prisma/client';
import type { TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export interface CreateVehicleUnitInput {
  tenantId: TenantId;
  vehicleId: string;
  unitRef: string;
  status?: 'ACTIVE' | 'MAINTENANCE' | 'RETIRED';
}

export async function createVehicleUnit(db: Executor, input: CreateVehicleUnitInput) {
  return db.vehicleUnit.create({
    data: {
      tenantId: input.tenantId,
      vehicleId: input.vehicleId,
      unitRef: input.unitRef,
      status: input.status ?? 'ACTIVE',
    },
  });
}

export interface UnitCounts {
  activeUnits: number;
  maintenanceUnits: number;
}

/** Real, database-backed inventory counts — what `DatabaseFleetProvider` reads. */
export async function countUnitsByStatus(
  db: Executor,
  tenantId: TenantId,
  vehicleId: string,
): Promise<UnitCounts> {
  const rows = await db.vehicleUnit.groupBy({
    by: ['status'],
    where: { tenantId, vehicleId },
    _count: { _all: true },
  });
  const activeUnits = rows.find((row) => row.status === 'ACTIVE')?._count._all ?? 0;
  const maintenanceUnits = rows.find((row) => row.status === 'MAINTENANCE')?._count._all ?? 0;
  return { activeUnits, maintenanceUnits };
}

export async function listUnitsForVehicle(db: Executor, tenantId: TenantId, vehicleId: string) {
  return db.vehicleUnit.findMany({ where: { tenantId, vehicleId }, orderBy: { unitRef: 'asc' } });
}
