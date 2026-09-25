import { describe, expect, it } from 'vitest';
import {
  FleetProviderError,
  type FleetInventorySnapshot,
  type FleetProvider,
} from './fleetProvider.js';
import { ResilientFleetProvider } from './resilientFleetProvider.js';

function snapshot(vehicleId: string): FleetInventorySnapshot {
  return {
    vehicleId,
    activeUnits: 2,
    maintenanceUnits: 0,
    source: 'fake',
    asOf: new Date().toISOString(),
  };
}

describe('ResilientFleetProvider', () => {
  it('passes through a successful call unchanged', async () => {
    const inner: FleetProvider = {
      name: 'fake',
      getInventorySnapshot: async (_t, vehicleId) => snapshot(vehicleId),
    };
    const provider = new ResilientFleetProvider(inner);

    const result = await provider.getInventorySnapshot('t1', 'v1');
    expect(result.vehicleId).toBe('v1');
    expect(result.activeUnits).toBe(2);
  });

  it('maps a call that never resolves to a FleetProviderError once the timeout elapses (API timeout)', async () => {
    const inner: FleetProvider = {
      name: 'hangs-forever',
      getInventorySnapshot: () => new Promise<FleetInventorySnapshot>(() => {}),
    };
    const provider = new ResilientFleetProvider(inner, { timeoutMs: 20 });

    await expect(provider.getInventorySnapshot('t1', 'v1')).rejects.toThrow(FleetProviderError);
  });

  it('maps the inner provider throwing to a FleetProviderError (provider failure)', async () => {
    const inner: FleetProvider = {
      name: 'always-fails',
      getInventorySnapshot: async () => {
        throw new Error('upstream fleet API returned 500');
      },
    };
    const provider = new ResilientFleetProvider(inner, { timeoutMs: 1000 });

    await expect(provider.getInventorySnapshot('t1', 'v1')).rejects.toThrow(FleetProviderError);
  });

  it('opens the circuit after repeated failures and stops calling the inner provider', async () => {
    let calls = 0;
    const inner: FleetProvider = {
      name: 'flaky',
      getInventorySnapshot: async () => {
        calls += 1;
        throw new Error('down');
      },
    };
    const provider = new ResilientFleetProvider(inner, {
      timeoutMs: 1000,
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
      rateLimiter: { maxCalls: 100, windowMs: 1000 },
    });

    await expect(provider.getInventorySnapshot('t1', 'v1')).rejects.toThrow(FleetProviderError);
    await expect(provider.getInventorySnapshot('t1', 'v1')).rejects.toThrow(FleetProviderError);
    expect(calls).toBe(2);

    // Circuit is now open — a third call must be refused without reaching the inner provider.
    await expect(provider.getInventorySnapshot('t1', 'v1')).rejects.toThrow(FleetProviderError);
    expect(calls).toBe(2);
  });

  it('enforces the rate limit without reaching the inner provider once exceeded', async () => {
    let calls = 0;
    const inner: FleetProvider = {
      name: 'counts-calls',
      getInventorySnapshot: async (_t, vehicleId) => {
        calls += 1;
        return snapshot(vehicleId);
      },
    };
    const provider = new ResilientFleetProvider(inner, {
      rateLimiter: { maxCalls: 1, windowMs: 60_000 },
    });

    await provider.getInventorySnapshot('t1', 'v1');
    await expect(provider.getInventorySnapshot('t1', 'v1')).rejects.toThrow(FleetProviderError);
    expect(calls).toBe(1);
  });

  it('preserves a FleetProviderError.retryable flag from the inner provider', async () => {
    const inner: FleetProvider = {
      name: 'not-configured',
      getInventorySnapshot: async () => {
        throw new FleetProviderError('not configured', { retryable: false });
      },
    };
    const provider = new ResilientFleetProvider(inner);

    try {
      await provider.getInventorySnapshot('t1', 'v1');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FleetProviderError);
      expect((error as FleetProviderError).retryable).toBe(false);
    }
  });
});
