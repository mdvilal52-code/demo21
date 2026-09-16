import {
  CircuitBreaker,
  RateLimiter,
  withTimeout,
  type CircuitBreakerOptions,
  type RateLimiterOptions,
} from '@ai-concierge/security';
import type { LocationCandidate, LocationProvider } from './locationProvider.js';

export interface ResilientLocationProviderOptions {
  timeoutMs?: number;
  circuitBreaker?: CircuitBreakerOptions;
  rateLimiter?: RateLimiterOptions;
}

const DEFAULT_OPTIONS: Required<ResilientLocationProviderOptions> = {
  timeoutMs: 3000,
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
  rateLimiter: { maxCalls: 50, windowMs: 1000 },
};

/**
 * Wraps any `LocationProvider` with a timeout, a circuit breaker, and a rate
 * limit. Applied even to the zero-network `GazetteerLocationProvider` so the
 * safety net is exercised end to end now, not bolted on the day a real
 * network-based geocoder replaces it.
 */
export class ResilientLocationProvider implements LocationProvider {
  readonly name: string;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly rateLimiter: RateLimiter;
  private readonly timeoutMs: number;

  constructor(
    private readonly inner: LocationProvider,
    options: ResilientLocationProviderOptions = {},
  ) {
    this.name = `resilient(${inner.name})`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs;
    this.circuitBreaker = new CircuitBreaker(
      options.circuitBreaker ?? DEFAULT_OPTIONS.circuitBreaker,
    );
    this.rateLimiter = new RateLimiter(options.rateLimiter ?? DEFAULT_OPTIONS.rateLimiter);
  }

  async resolve(text: string): Promise<LocationCandidate[]> {
    this.rateLimiter.acquireOrThrow();
    return this.circuitBreaker.execute(() =>
      withTimeout(() => this.inner.resolve(text), this.timeoutMs),
    );
  }
}
