/**
 * Generic resilience primitives for any outbound call to a third-party
 * provider (geocoding, payments, …) — not geocoding-specific. Phase 2 uses
 * these to wrap the location provider seam so a future network-based
 * geocoder inherits working timeout/circuit-breaker/rate-limit behavior on
 * day one instead of bolting it on under deadline pressure.
 */

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor() {
    super('Circuit breaker is open; refusing to call the upstream provider');
    this.name = 'CircuitBreakerOpenError';
  }
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
}

/**
 * Trips OPEN after `failureThreshold` consecutive failures, refusing every
 * call until `resetTimeoutMs` has elapsed. The next call after that window
 * is let through as a HALF_OPEN probe: success closes the circuit, failure
 * re-opens it immediately.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(private readonly options: CircuitBreakerOptions) {}

  getState(): CircuitState {
    if (this.state === 'OPEN' && Date.now() - this.openedAt >= this.options.resetTimeoutMs) {
      return 'HALF_OPEN';
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();
    if (currentState === 'OPEN') {
      throw new CircuitBreakerOpenError();
    }

    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      this.state = 'CLOSED';
      return result;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.options.failureThreshold) {
        this.state = 'OPEN';
        this.openedAt = Date.now();
      }
      throw error;
    }
  }
}

export class RateLimitExceededError extends Error {
  constructor() {
    super('Rate limit exceeded for this provider');
    this.name = 'RateLimitExceededError';
  }
}

export interface RateLimiterOptions {
  maxCalls: number;
  windowMs: number;
}

/** Fixed-window counter — enough to bound call volume to a downstream provider. */
export class RateLimiter {
  private windowStart = Date.now();
  private count = 0;

  constructor(private readonly options: RateLimiterOptions) {}

  tryAcquire(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= this.options.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.options.maxCalls) {
      return false;
    }
    this.count += 1;
    return true;
  }

  acquireOrThrow(): void {
    if (!this.tryAcquire()) {
      throw new RateLimitExceededError();
    }
  }
}
