import type { FleetInventorySnapshot, FleetProvider } from '@ai-concierge/ai';
import type { Redis } from 'ioredis';

const CACHE_KEY_PREFIX = 'fleet-inventory';

/**
 * "Redis may assist but database remains source of truth": caches an
 * external `FleetProvider`'s unit-count facts for a short TTL to reduce
 * repeated calls to a (potentially slow/rate-limited) third-party API — it
 * never caches hold/booking state, which always lives in and is read fresh
 * from Postgres inside `ReservationLockService`'s locked transaction. Not
 * applied to `DatabaseFleetProvider` (already a fast local read; caching it
 * would only add staleness risk for no benefit). A Redis outage degrades to
 * "call the inner provider every time", never a fabricated snapshot — the
 * cache is a pure optimization, never a correctness dependency.
 */
export class CachedFleetProvider implements FleetProvider {
  readonly name: string;

  constructor(
    private readonly inner: FleetProvider,
    private readonly redis: Redis,
    private readonly ttlSeconds = 30,
  ) {
    this.name = `cached(${inner.name})`;
  }

  async getInventorySnapshot(tenantId: string, vehicleId: string): Promise<FleetInventorySnapshot> {
    const key = `${CACHE_KEY_PREFIX}:${tenantId}:${vehicleId}`;

    try {
      const cached = await this.redis.get(key);
      if (cached) {
        return JSON.parse(cached) as FleetInventorySnapshot;
      }
    } catch {
      // Redis unavailable/corrupt entry — fall through to the inner provider; never fail the check over a cache problem.
    }

    const snapshot = await this.inner.getInventorySnapshot(tenantId, vehicleId);

    try {
      await this.redis.set(key, JSON.stringify(snapshot), 'EX', this.ttlSeconds);
    } catch {
      // Best-effort only — a failed cache write must never surface as a FleetProviderError.
    }

    return snapshot;
  }
}
