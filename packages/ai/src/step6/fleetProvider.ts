/**
 * Seam between the pure Step 6 logic (`packages/ai`, zero DB/network
 * dependency) and the real physical fleet ("database is authoritative —
 * never invent inventory"), mirroring Step 2's `LocationProvider` / Step 3's
 * `VehicleCatalogProvider` layering. Concrete implementations
 * (`DatabaseFleetProvider`, `ExternalFleetApiProvider`,
 * `NotConfiguredFleetProvider`) live in `apps/api` — the composition root
 * that already depends on both `@ai-concierge/ai` and `@ai-concierge/db`.
 *
 * A provider must never fabricate a snapshot on failure — throw
 * `FleetProviderError` instead so the caller can map it to `UNKNOWN`
 * ("Failure: UNKNOWN + human/system retry", never a fake AVAILABLE).
 */
export interface FleetInventorySnapshot {
  vehicleId: string;
  /** Units genuinely available to rent right now (excludes MAINTENANCE/RETIRED). */
  activeUnits: number;
  maintenanceUnits: number;
  source: string;
  /** ISO instant this snapshot was read — for observability, never used in comparisons. */
  asOf: string;
}

export class FleetProviderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'FleetProviderError';
    this.retryable = options.retryable ?? true;
  }
}

export interface FleetProvider {
  readonly name: string;
  getInventorySnapshot(tenantId: string, vehicleId: string): Promise<FleetInventorySnapshot>;
}
