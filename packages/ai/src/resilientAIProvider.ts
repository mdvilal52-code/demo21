import {
  CircuitBreaker,
  RateLimiter,
  withTimeout,
  type CircuitBreakerOptions,
  type RateLimiterOptions,
} from '@ai-concierge/security';
import type {
  AIProvider,
  AIProviderHealth,
  GenerateStructuredInput,
  GenerateStructuredResult,
} from './provider.js';

export interface ResilientAIProviderOptions {
  timeoutMs?: number;
  circuitBreaker?: CircuitBreakerOptions;
  rateLimiter?: RateLimiterOptions;
}

const DEFAULT_OPTIONS: Required<ResilientAIProviderOptions> = {
  timeoutMs: 8000,
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
  rateLimiter: { maxCalls: 20, windowMs: 1000 },
};

/**
 * Wraps any `AIProvider` with a timeout, a circuit breaker, and a rate
 * limit — same discipline as `ResilientLocationProvider` (Step 2) applied to
 * the conversational reply seam, so a live model call can never hang a
 * request indefinitely or hammer a failing upstream.
 */
export class ResilientAIProvider implements AIProvider {
  readonly name: string;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly rateLimiter: RateLimiter;
  private readonly timeoutMs: number;

  constructor(
    private readonly inner: AIProvider,
    options: ResilientAIProviderOptions = {},
  ) {
    this.name = `resilient(${inner.name})`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs;
    this.circuitBreaker = new CircuitBreaker(
      options.circuitBreaker ?? DEFAULT_OPTIONS.circuitBreaker,
    );
    this.rateLimiter = new RateLimiter(options.rateLimiter ?? DEFAULT_OPTIONS.rateLimiter);
  }

  async generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult> {
    this.rateLimiter.acquireOrThrow();
    return this.circuitBreaker.execute(() =>
      withTimeout(() => this.inner.generateStructured(input), input.timeoutMs ?? this.timeoutMs),
    );
  }

  async healthCheck(): Promise<AIProviderHealth> {
    return this.inner.healthCheck();
  }
}
