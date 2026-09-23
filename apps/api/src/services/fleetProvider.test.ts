import { FleetProviderError } from '@ai-concierge/ai';
import { describe, expect, it, vi } from 'vitest';
import {
  DatabaseFleetProvider,
  ExternalFleetApiProvider,
  NotConfiguredFleetProvider,
} from './fleetProvider.js';

describe('NotConfiguredFleetProvider', () => {
  it('throws a non-retryable FleetProviderError rather than faking a snapshot', async () => {
    const provider = new NotConfiguredFleetProvider();
    await expect(provider.getInventorySnapshot('t1', 'v1')).rejects.toThrow(FleetProviderError);
    try {
      await provider.getInventorySnapshot('t1', 'v1');
      expect.unreachable();
    } catch (error) {
      expect((error as FleetProviderError).retryable).toBe(false);
    }
  });
});

describe('DatabaseFleetProvider', () => {
  it('reports the real counted units as the snapshot (real database-backed inventory)', async () => {
    const prisma = {
      vehicleUnit: {
        groupBy: vi.fn().mockResolvedValue([
          { status: 'ACTIVE', _count: { _all: 2 } },
          { status: 'MAINTENANCE', _count: { _all: 1 } },
        ]),
      },
    };
    const provider = new DatabaseFleetProvider(prisma as never);

    const snapshot = await provider.getInventorySnapshot('t1', 'v1');
    expect(snapshot).toMatchObject({
      vehicleId: 'v1',
      activeUnits: 2,
      maintenanceUnits: 1,
      source: 'database-fleet',
    });
  });

  it('wraps an unexpected database error in a retryable FleetProviderError (provider failure)', async () => {
    const prisma = {
      vehicleUnit: {
        groupBy: vi.fn().mockRejectedValue(new Error('connection reset')),
      },
    };
    const provider = new DatabaseFleetProvider(prisma as never);

    await expect(provider.getInventorySnapshot('t1', 'v1')).rejects.toThrow(FleetProviderError);
  });
});

describe('ExternalFleetApiProvider', () => {
  const config = { baseUrl: 'https://fleet.example.com', apiKey: 'secret-key', timeoutMs: 3000 };

  it('calls the configured host with the expected URL and auth header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ activeUnits: 4, maintenanceUnits: 1 }),
    });
    const provider = new ExternalFleetApiProvider(config, fetchImpl as never);

    const snapshot = await provider.getInventorySnapshot('t1', 'v1');
    expect(snapshot).toMatchObject({ vehicleId: 'v1', activeUnits: 4, maintenanceUnits: 1 });

    const [url, allowedHosts, options] = fetchImpl.mock.calls[0] as [
      string,
      string[],
      RequestInit & { timeoutMs?: number },
    ];
    expect(url).toBe('https://fleet.example.com/tenants/t1/vehicles/v1/inventory');
    expect(allowedHosts).toEqual(['fleet.example.com']);
    expect(options.headers).toMatchObject({ authorization: 'Bearer secret-key' });
  });

  it('throws a retryable FleetProviderError when the network call itself rejects (API timeout)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('the operation was aborted'));
    const provider = new ExternalFleetApiProvider(config, fetchImpl as never);

    try {
      await provider.getInventorySnapshot('t1', 'v1');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FleetProviderError);
      expect((error as FleetProviderError).retryable).toBe(true);
    }
  });

  it('throws a retryable FleetProviderError on a 5xx response (provider failure)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const provider = new ExternalFleetApiProvider(config, fetchImpl as never);

    try {
      await provider.getInventorySnapshot('t1', 'v1');
      expect.unreachable();
    } catch (error) {
      expect((error as FleetProviderError).retryable).toBe(true);
    }
  });

  it('throws a non-retryable FleetProviderError on a 4xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const provider = new ExternalFleetApiProvider(config, fetchImpl as never);

    try {
      await provider.getInventorySnapshot('t1', 'v1');
      expect.unreachable();
    } catch (error) {
      expect((error as FleetProviderError).retryable).toBe(false);
    }
  });

  it('never fabricates a snapshot from an unrecognized response shape', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ unexpected: true }) });
    const provider = new ExternalFleetApiProvider(config, fetchImpl as never);

    await expect(provider.getInventorySnapshot('t1', 'v1')).rejects.toThrow(FleetProviderError);
  });
});
