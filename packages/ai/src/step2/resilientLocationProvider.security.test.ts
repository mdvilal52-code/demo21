import {
  CircuitBreakerOpenError,
  RateLimitExceededError,
  TimeoutError,
} from '@ai-concierge/security';
import { describe, expect, it } from 'vitest';
import { ResilientLocationProvider } from './resilientLocationProvider.js';
import type { LocationCandidate, LocationProvider } from './locationProvider.js';

function makeSlowProvider(delayMs: number): LocationProvider {
  return {
    name: 'slow-fake',
    resolve: () =>
      new Promise<LocationCandidate[]>((resolve) => setTimeout(() => resolve([]), delayMs)),
  };
}

function makeFailingProvider(): LocationProvider {
  return {
    name: 'failing-fake',
    resolve: () => Promise.reject(new Error('upstream geocoder unreachable')),
  };
}

describe('ResilientLocationProvider — security/resilience', () => {
  it('times out a hanging provider instead of waiting forever', async () => {
    const provider = new ResilientLocationProvider(makeSlowProvider(500), { timeoutMs: 20 });
    await expect(provider.resolve('anything')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('opens the circuit after repeated failures and stops calling the upstream provider', async () => {
    const provider = new ResilientLocationProvider(makeFailingProvider(), {
      timeoutMs: 1000,
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 10_000 },
      rateLimiter: { maxCalls: 100, windowMs: 1000 },
    });

    await expect(provider.resolve('x')).rejects.toThrow('upstream geocoder unreachable');
    await expect(provider.resolve('x')).rejects.toThrow('upstream geocoder unreachable');
    await expect(provider.resolve('x')).rejects.toBeInstanceOf(CircuitBreakerOpenError);
  });

  it('enforces a rate limit on calls to the provider', async () => {
    const provider = new ResilientLocationProvider(makeSlowProvider(0), {
      rateLimiter: { maxCalls: 1, windowMs: 60_000 },
    });
    await expect(provider.resolve('first')).resolves.toEqual([]);
    await expect(provider.resolve('second')).rejects.toBeInstanceOf(RateLimitExceededError);
  });
});
