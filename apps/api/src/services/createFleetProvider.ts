import { ResilientFleetProvider, type FleetProvider } from '@ai-concierge/ai';
import type { PrismaClient } from '@ai-concierge/db';
import type { Redis } from 'ioredis';
import { CachedFleetProvider } from './cachedFleetProvider.js';
import type { ApiEnv } from '../env.js';
import {
  DatabaseFleetProvider,
  ExternalFleetApiProvider,
  NotConfiguredFleetProvider,
} from './fleetProvider.js';

/**
 * "Database remains source of truth": `database` (the default) needs no
 * configuration and is always real. `external` opts a tenant into a
 * third-party fleet system; left unconfigured, it reports NOT_CONFIGURED
 * rather than silently falling back — an operator who asked for the
 * external provider should see that clearly, not get a quietly different
 * one. The external path is wrapped with `ResilientFleetProvider`
 * (timeout/circuit-breaker/rate-limit) and `CachedFleetProvider` (a short
 * Redis TTL, per "Redis may assist"); the database path needs neither (no
 * network call to bound, no external latency worth caching away).
 */
export function createFleetProvider(
  config: ApiEnv,
  prisma: PrismaClient,
  redis: Redis,
): FleetProvider {
  if (config.FLEET_PROVIDER !== 'external') {
    return new DatabaseFleetProvider(prisma);
  }
  if (!config.FLEET_API_BASE_URL || !config.FLEET_API_KEY) {
    return new NotConfiguredFleetProvider();
  }
  const external = new ExternalFleetApiProvider({
    baseUrl: config.FLEET_API_BASE_URL,
    apiKey: config.FLEET_API_KEY,
    timeoutMs: config.FLEET_API_TIMEOUT_MS,
  });
  const resilient = new ResilientFleetProvider(external, {
    timeoutMs: config.FLEET_API_TIMEOUT_MS,
  });
  return new CachedFleetProvider(resilient, redis);
}
