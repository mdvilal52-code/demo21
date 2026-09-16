import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  RateLimiter,
  RateLimitExceededError,
  TimeoutError,
  withTimeout,
} from './resilience.js';

describe('withTimeout', () => {
  it('resolves normally when the operation finishes in time', async () => {
    const result = await withTimeout(() => Promise.resolve('ok'), 50);
    expect(result).toBe('ok');
  });

  it('rejects with TimeoutError when the operation takes too long', async () => {
    const hang = () => new Promise((resolve) => setTimeout(() => resolve('late'), 200));
    await expect(withTimeout(hang, 20)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('propagates the original rejection when the operation fails before the timeout', async () => {
    const fail = () => Promise.reject(new Error('boom'));
    await expect(withTimeout(fail, 50)).rejects.toThrow('boom');
  });
});

describe('CircuitBreaker', () => {
  it('starts CLOSED and allows calls through', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    expect(breaker.getState()).toBe('CLOSED');
    await expect(breaker.execute(() => Promise.resolve(1))).resolves.toBe(1);
  });

  it('opens after reaching the failure threshold and rejects further calls immediately', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    const failing = () => Promise.reject(new Error('upstream down'));

    await expect(breaker.execute(failing)).rejects.toThrow('upstream down');
    await expect(breaker.execute(failing)).rejects.toThrow('upstream down');
    expect(breaker.getState()).toBe('OPEN');

    await expect(breaker.execute(() => Promise.resolve('never called'))).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    );
  });

  it('resets the failure count after a success', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    await expect(breaker.execute(() => Promise.reject(new Error('one')))).rejects.toThrow();
    await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
    // a second failure alone should not trip it, since the first was reset
    await expect(breaker.execute(() => Promise.reject(new Error('two')))).rejects.toThrow();
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('moves to HALF_OPEN after the reset window and closes again on success', async () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100 });
      await expect(breaker.execute(() => Promise.reject(new Error('down')))).rejects.toThrow();
      expect(breaker.getState()).toBe('OPEN');

      vi.advanceTimersByTime(150);
      expect(breaker.getState()).toBe('HALF_OPEN');

      await expect(breaker.execute(() => Promise.resolve('recovered'))).resolves.toBe('recovered');
      expect(breaker.getState()).toBe('CLOSED');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RateLimiter', () => {
  it('allows calls up to the configured maximum within the window', () => {
    const limiter = new RateLimiter({ maxCalls: 2, windowMs: 1000 });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('throws RateLimitExceededError from acquireOrThrow once exhausted', () => {
    const limiter = new RateLimiter({ maxCalls: 1, windowMs: 1000 });
    limiter.acquireOrThrow();
    expect(() => limiter.acquireOrThrow()).toThrow(RateLimitExceededError);
  });

  it('resets the count once the window elapses', () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter({ maxCalls: 1, windowMs: 100 });
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
      vi.advanceTimersByTime(150);
      expect(limiter.tryAcquire()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
