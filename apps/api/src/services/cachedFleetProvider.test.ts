import type { FleetInventorySnapshot, FleetProvider } from '@ai-concierge/ai';
import { describe, expect, it, vi } from 'vitest';
import { CachedFleetProvider } from './cachedFleetProvider.js';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
  };
}

function snapshot(vehicleId: string): FleetInventorySnapshot {
  return {
    vehicleId,
    activeUnits: 3,
    maintenanceUnits: 0,
    source: 'inner',
    asOf: new Date().toISOString(),
  };
}

describe('CachedFleetProvider', () => {
  it('calls through to the inner provider on a cache miss and caches the result', async () => {
    const redis = fakeRedis();
    const inner: FleetProvider = {
      name: 'inner',
      getInventorySnapshot: vi.fn(async (_t, vehicleId) => snapshot(vehicleId)),
    };
    const provider = new CachedFleetProvider(inner, redis as never, 30);

    const first = await provider.getInventorySnapshot('t1', 'v1');
    expect(first.activeUnits).toBe(3);
    expect(inner.getInventorySnapshot).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith('fleet-inventory:t1:v1', expect.any(String), 'EX', 30);
  });

  it('serves a cache hit without calling the inner provider again', async () => {
    const redis = fakeRedis();
    const inner: FleetProvider = {
      name: 'inner',
      getInventorySnapshot: vi.fn(async (_t, vehicleId) => snapshot(vehicleId)),
    };
    const provider = new CachedFleetProvider(inner, redis as never, 30);

    await provider.getInventorySnapshot('t1', 'v1');
    const second = await provider.getInventorySnapshot('t1', 'v1');

    expect(second.activeUnits).toBe(3);
    expect(inner.getInventorySnapshot).toHaveBeenCalledTimes(1);
  });

  it('falls through to the inner provider (never fails the check) when Redis reads fail', async () => {
    const inner: FleetProvider = {
      name: 'inner',
      getInventorySnapshot: vi.fn(async (_t, vehicleId) => snapshot(vehicleId)),
    };
    const brokenRedis = {
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const provider = new CachedFleetProvider(inner, brokenRedis as never, 30);

    await expect(provider.getInventorySnapshot('t1', 'v1')).resolves.toMatchObject({
      activeUnits: 3,
    });
    expect(inner.getInventorySnapshot).toHaveBeenCalledTimes(1);
  });

  it('scopes cache keys per tenant and vehicle', async () => {
    const redis = fakeRedis();
    const inner: FleetProvider = {
      name: 'inner',
      getInventorySnapshot: vi.fn(async (_t, vehicleId) => snapshot(vehicleId)),
    };
    const provider = new CachedFleetProvider(inner, redis as never, 30);

    await provider.getInventorySnapshot('t1', 'v1');
    await provider.getInventorySnapshot('t2', 'v1');

    expect(inner.getInventorySnapshot).toHaveBeenCalledTimes(2);
  });
});
