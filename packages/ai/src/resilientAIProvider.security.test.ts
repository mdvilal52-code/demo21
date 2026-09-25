import {
  CircuitBreakerOpenError,
  RateLimitExceededError,
  TimeoutError,
} from '@ai-concierge/security';
import { describe, expect, it } from 'vitest';
import { ResilientAIProvider } from './resilientAIProvider.js';
import type { AIProvider, GenerateStructuredResult } from './provider.js';

const FAKE_RESULT: GenerateStructuredResult = {
  json: { reply: 'ok' },
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  modelId: 'fake-model',
  latencyMs: 0,
};

function makeSlowProvider(delayMs: number): AIProvider {
  return {
    name: 'slow-fake',
    generateStructured: () =>
      new Promise((resolve) => setTimeout(() => resolve(FAKE_RESULT), delayMs)),
    healthCheck: async () => 'CONFIGURED',
  };
}

function makeFailingProvider(): AIProvider {
  return {
    name: 'failing-fake',
    generateStructured: () => Promise.reject(new Error('upstream model unreachable')),
    healthCheck: async () => 'UNAVAILABLE',
  };
}

const INPUT = { systemInstruction: 'x', prompt: 'x', schemaName: 'test' };

describe('ResilientAIProvider — security/resilience', () => {
  it('times out a hanging model call instead of waiting forever', async () => {
    const provider = new ResilientAIProvider(makeSlowProvider(500), { timeoutMs: 20 });
    await expect(provider.generateStructured(INPUT)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('opens the circuit after repeated failures and stops calling the upstream model', async () => {
    const provider = new ResilientAIProvider(makeFailingProvider(), {
      timeoutMs: 1000,
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 10_000 },
      rateLimiter: { maxCalls: 100, windowMs: 1000 },
    });

    await expect(provider.generateStructured(INPUT)).rejects.toThrow('upstream model unreachable');
    await expect(provider.generateStructured(INPUT)).rejects.toThrow('upstream model unreachable');
    await expect(provider.generateStructured(INPUT)).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    );
  });

  it('enforces a rate limit on calls to the model', async () => {
    const provider = new ResilientAIProvider(makeSlowProvider(0), {
      rateLimiter: { maxCalls: 1, windowMs: 60_000 },
    });
    await expect(provider.generateStructured(INPUT)).resolves.toEqual(FAKE_RESULT);
    await expect(provider.generateStructured(INPUT)).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it('delegates health checks straight through to the wrapped provider', async () => {
    const provider = new ResilientAIProvider(makeFailingProvider());
    await expect(provider.healthCheck()).resolves.toBe('UNAVAILABLE');
  });
});
