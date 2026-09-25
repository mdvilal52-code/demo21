import {
  FleetProviderError,
  type FleetInventorySnapshot,
  type FleetProvider,
} from '@ai-concierge/ai';
import { countUnitsByStatus, type PrismaClient } from '@ai-concierge/db';
import { ssrfSafeFetch } from '@ai-concierge/security';

/**
 * The default, always-on `FleetProvider` — real, database-backed inventory
 * (`VehicleUnit` rows). "Database remains source of truth": this is the
 * provider active unless an operator explicitly opts into an external fleet
 * system, and it never reports NOT_CONFIGURED — our own database is always
 * a real source, never a missing external credential.
 */
export class DatabaseFleetProvider implements FleetProvider {
  readonly name = 'database-fleet';

  constructor(private readonly prisma: PrismaClient) {}

  async getInventorySnapshot(tenantId: string, vehicleId: string): Promise<FleetInventorySnapshot> {
    try {
      const counts = await countUnitsByStatus(this.prisma, tenantId, vehicleId);
      return {
        vehicleId,
        activeUnits: counts.activeUnits,
        maintenanceUnits: counts.maintenanceUnits,
        source: this.name,
        asOf: new Date().toISOString(),
      };
    } catch (error) {
      throw new FleetProviderError('Database fleet lookup failed', {
        retryable: true,
        cause: error,
      });
    }
  }
}

/** No external fleet API configured for this environment — never fakes a snapshot. */
export class NotConfiguredFleetProvider implements FleetProvider {
  readonly name = 'not-configured';

  async getInventorySnapshot(
    _tenantId: string,
    _vehicleId: string,
  ): Promise<FleetInventorySnapshot> {
    throw new FleetProviderError('External fleet API is not configured', { retryable: false });
  }
}

export interface ExternalFleetApiConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

interface ExternalFleetApiResponseShape {
  activeUnits?: unknown;
  maintenanceUnits?: unknown;
}

/**
 * Real third-party fleet-management API adapter — the "external fleet API
 * adapter interface" the architecture requires. `fetchImpl` is injectable so
 * tests substitute a fake instead of a real network call (test doubles only
 * in test code, never wired into a production path). No real external fleet
 * system exists to integrate with in this environment; this reports
 * failures honestly (never a fabricated snapshot) and is unit-tested against
 * a fake fetch, exactly like `MetaWhatsAppProvider`.
 */
export class ExternalFleetApiProvider implements FleetProvider {
  readonly name = 'external-fleet-api';
  private readonly allowedHost: string;

  constructor(
    private readonly config: ExternalFleetApiConfig,
    private readonly fetchImpl: typeof ssrfSafeFetch = ssrfSafeFetch,
  ) {
    this.allowedHost = new URL(config.baseUrl).hostname;
  }

  async getInventorySnapshot(tenantId: string, vehicleId: string): Promise<FleetInventorySnapshot> {
    const url = `${this.config.baseUrl}/tenants/${encodeURIComponent(tenantId)}/vehicles/${encodeURIComponent(vehicleId)}/inventory`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, [this.allowedHost], {
        method: 'GET',
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        timeoutMs: this.config.timeoutMs,
      });
    } catch (error) {
      throw new FleetProviderError('External fleet API call failed', {
        retryable: true,
        cause: error,
      });
    }

    if (!response.ok) {
      throw new FleetProviderError(`External fleet API responded ${response.status}`, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }

    const json = (await response.json().catch(() => null)) as ExternalFleetApiResponseShape | null;
    const activeUnits = Number(json?.activeUnits);
    const maintenanceUnits = Number(json?.maintenanceUnits);
    if (!Number.isFinite(activeUnits) || !Number.isFinite(maintenanceUnits)) {
      throw new FleetProviderError('External fleet API returned an unrecognized response shape', {
        retryable: false,
      });
    }

    return {
      vehicleId,
      activeUnits,
      maintenanceUnits,
      source: this.name,
      asOf: new Date().toISOString(),
    };
  }
}
