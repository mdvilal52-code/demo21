import { describe, expect, it, vi } from 'vitest';
import type { AvailabilityProvider } from './availabilityProvider.js';
import {
  AvailabilityCheckOrchestrator,
  AvailabilityRequestError,
  validateAvailabilityRequest,
} from './orchestrator.js';

const NOW = new Date('2026-10-01T00:00:00.000Z');

describe('validateAvailabilityRequest', () => {
  it('passes for a well-formed future range', () => {
    expect(() =>
      validateAvailabilityRequest(
        new Date('2026-10-05T10:00:00.000Z'),
        new Date('2026-10-08T10:00:00.000Z'),
        NOW,
      ),
    ).not.toThrow();
  });

  it('rejects a return date equal to the pickup date', () => {
    const pickup = new Date('2026-10-05T10:00:00.000Z');
    expect(() => validateAvailabilityRequest(pickup, new Date(pickup), NOW)).toThrow(
      AvailabilityRequestError,
    );
  });

  it('rejects a return date before the pickup date', () => {
    expect(() =>
      validateAvailabilityRequest(
        new Date('2026-10-08T10:00:00.000Z'),
        new Date('2026-10-05T10:00:00.000Z'),
        NOW,
      ),
    ).toThrow(AvailabilityRequestError);
  });

  it('rejects a pickup date that has gone stale (now in the past) since Step 2 resolved it', () => {
    expect(() =>
      validateAvailabilityRequest(
        new Date('2026-09-01T10:00:00.000Z'),
        new Date('2026-09-05T10:00:00.000Z'),
        NOW,
      ),
    ).toThrow(AvailabilityRequestError);
  });

  it('carries the specific error code for each failure', () => {
    try {
      validateAvailabilityRequest(
        new Date('2026-09-01T10:00:00.000Z'),
        new Date('2026-09-05T10:00:00.000Z'),
        NOW,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AvailabilityRequestError);
      expect((error as AvailabilityRequestError).code).toBe('PICKUP_DATE_NOW_IN_PAST');
    }
  });
});

describe('AvailabilityCheckOrchestrator', () => {
  function makeProvider(outcome: Awaited<ReturnType<AvailabilityProvider['checkAvailability']>>) {
    return { name: 'fake', checkAvailability: vi.fn().mockResolvedValue(outcome) };
  }

  it('delegates to the provider once the request validates', async () => {
    const provider = makeProvider({
      status: 'AVAILABLE',
      source: 'fake',
      reason: null,
      retryable: false,
    });
    const orchestrator = new AvailabilityCheckOrchestrator({ provider });

    const result = await orchestrator.check({
      tenantId: 't1',
      vehicleId: 'v1',
      pickupAt: new Date('2026-10-05T10:00:00.000Z'),
      returnAt: new Date('2026-10-08T10:00:00.000Z'),
      now: NOW,
    });

    expect(result.status).toBe('AVAILABLE');
    expect(provider.checkAvailability).toHaveBeenCalledWith({
      tenantId: 't1',
      vehicleId: 'v1',
      pickupAt: new Date('2026-10-05T10:00:00.000Z'),
      returnAt: new Date('2026-10-08T10:00:00.000Z'),
    });
  });

  it('never calls the provider when the request itself is invalid', async () => {
    const provider = makeProvider({
      status: 'AVAILABLE',
      source: 'fake',
      reason: null,
      retryable: false,
    });
    const orchestrator = new AvailabilityCheckOrchestrator({ provider });

    await expect(
      orchestrator.check({
        tenantId: 't1',
        vehicleId: 'v1',
        pickupAt: new Date('2026-09-01T10:00:00.000Z'),
        returnAt: new Date('2026-09-05T10:00:00.000Z'),
        now: NOW,
      }),
    ).rejects.toThrow(AvailabilityRequestError);
    expect(provider.checkAvailability).not.toHaveBeenCalled();
  });
});
