import {
  CircuitBreaker,
  RateLimiter,
  withTimeout,
  type CircuitBreakerOptions,
  type RateLimiterOptions,
} from '@ai-concierge/security';
import {
  FleetProviderError,
  type FleetInventorySnapshot,
  type FleetProvider,
} from './fleetProvider.js';

export interface ResilientFleetProviderOptions {
  timeoutMs?: number;
  circuitBreaker?: CircuitBreakerOptions;
  rateLimiter?: RateLimiterOptions;
}

const DEFAULT_OPTIONS: Required<ResilientFleetProviderOptions> = {
  timeoutMs: 3000,
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
  rateLimiter: { maxCalls: 50, windowMs: 1000 },
};

/**
 * Wraps any `FleetProvider` with a timeout, a circuit breaker, and a rate
 * limit — the same safety net Step 2's `ResilientLocationProvider` applies,
 * needed here specifically for an external, network-based fleet API adapter
 * (a database-backed provider has no network call to time out, but wrapping
 * it too costs nothing and keeps behavior uniform regardless of which
 * concrete provider is active). Every failure — timeout, circuit open, or
 * the inner provider's own rejection — surfaces as `FleetProviderError`, so
 * callers have exactly one error type to map to `UNKNOWN`.
 */
export class ResilientFleetProvider implements FleetProvider {
  readonly name: string;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly rateLimiter: RateLimiter;
  private readonly timeoutMs: number;

  constructor(
    private readonly inner: FleetProvider,
    options: ResilientFleetProviderOptions = {},
  ) {
    this.name = `resilient(${inner.name})`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs;
    this.circuitBreaker = new CircuitBreaker(
      options.circuitBreaker ?? DEFAULT_OPTIONS.circuitBreaker,
    );
    this.rateLimiter = new RateLimiter(options.rateLimiter ?? DEFAULT_OPTIONS.rateLimiter);
  }

  async getInventorySnapshot(tenantId: string, vehicleId: string): Promise<FleetInventorySnapshot> {
    try {
      this.rateLimiter.acquireOrThrow();
      return await this.circuitBreaker.execute(() =>
        withTimeout(() => this.inner.getInventorySnapshot(tenantId, vehicleId), this.timeoutMs),
      );
    } catch (error) {
      if (error instanceof FleetProviderError) throw error;
      throw new FleetProviderError(
        error instanceof Error ? error.message : 'Fleet provider call failed',
        { retryable: true, cause: error },
      );
    }
  }
}
