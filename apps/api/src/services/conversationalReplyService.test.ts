import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@ai-concierge/domain';
import type { AIProvider, GenerateStructuredResult } from '@ai-concierge/ai';
import { generateConversationalReply } from './conversationalReplyService.js';

const fakeMissingInfo = {
  status: 'NEEDS_INFO' as const,
  collected: {
    pickupDate: null,
    returnDate: null,
    pickupLocation: null,
    dropoffLocation: null,
    vehicle: null,
  },
  missingFields: [],
  clarificationPrompt: 'When would you like to pick up the car?',
  expiresAt: '2026-09-21T00:00:00.000Z',
  flags: { promptInjectionDetectedAnywhere: false },
  modelMetadata: { engine: 'missing-info-evaluator-v1', version: '0.1.0', deterministic: true },
};

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

function makeProvider(result: GenerateStructuredResult): AIProvider {
  return {
    name: 'fake',
    generateStructured: vi.fn().mockResolvedValue(result),
    healthCheck: async () => 'CONFIGURED',
  };
}

const okResult: GenerateStructuredResult = {
  json: { reply: 'Happy to help — which dates work for you?' },
  usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
  modelId: 'gemini-3.8-flash',
  latencyMs: 100,
};

describe('generateConversationalReply', () => {
  it('falls back to the deterministic template when the provider is not configured', async () => {
    const provider: AIProvider = {
      name: 'not-configured',
      generateStructured: vi.fn().mockRejectedValue(
        new AppError('NOT_CONFIGURED', 'No AI provider is configured for this environment'),
      ),
      healthCheck: async () => 'NOT_CONFIGURED',
    };

    const result = await generateConversationalReply(
      { aiProvider: provider, logger: makeLogger() },
      { missingInfo: fakeMissingInfo, recentTurns: [] },
    );

    expect(result).toEqual({
      text: fakeMissingInfo.clarificationPrompt,
      source: 'DETERMINISTIC_FALLBACK',
      fallbackReason: 'NOT_CONFIGURED',
    });
  });

  it('returns the AI-generated reply when it is well-formed and grounded', async () => {
    const provider = makeProvider(okResult);

    const result = await generateConversationalReply(
      { aiProvider: provider, logger: makeLogger() },
      {
        missingInfo: fakeMissingInfo,
        recentTurns: [{ role: 'customer', content: 'I need a Urus next month' }],
      },
    );

    expect(result.source).toBe('AI_GENERATED');
    expect(result.text).toBe('Happy to help — which dates work for you?');

    const call = (provider.generateStructured as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.prompt).toContain('I need a Urus next month');
    expect(call?.prompt).toContain('"status": "NEEDS_INFO"');
  });

  it('falls back when the model output fails schema validation', async () => {
    const provider = makeProvider({ ...okResult, json: { notReply: 'oops' } });

    const result = await generateConversationalReply(
      { aiProvider: provider, logger: makeLogger() },
      { missingInfo: fakeMissingInfo, recentTurns: [] },
    );

    expect(result.source).toBe('DETERMINISTIC_FALLBACK');
    expect(result.fallbackReason).toBe('SCHEMA_INVALID');
    expect(result.text).toBe(fakeMissingInfo.clarificationPrompt);
  });

  it('falls back when the provider throws (timeout, circuit open, network error)', async () => {
    const provider: AIProvider = {
      name: 'fake',
      generateStructured: vi.fn().mockRejectedValue(new Error('boom')),
      healthCheck: async () => 'CONFIGURED',
    };

    const result = await generateConversationalReply(
      { aiProvider: provider, logger: makeLogger() },
      { missingInfo: fakeMissingInfo, recentTurns: [] },
    );

    expect(result.source).toBe('DETERMINISTIC_FALLBACK');
    expect(result.fallbackReason).toBe('PROVIDER_ERROR');
  });
});
