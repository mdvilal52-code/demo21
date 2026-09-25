import { beforeEach, describe, expect, it } from 'vitest';
import { NotConfiguredProvider, ResilientAIProvider } from '@ai-concierge/ai';
import { vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ssrfSafeFetch: vi.fn() }));

vi.mock('@ai-concierge/security', async () => {
  const actual = await vi.importActual<typeof import('@ai-concierge/security')>(
    '@ai-concierge/security',
  );
  return { ...actual, ssrfSafeFetch: mocks.ssrfSafeFetch };
});

const { GeminiProvider, createAIProvider } = await import('./geminiProvider.js');

const CONFIG = {
  apiKey: 'test-key',
  modelId: 'gemini-3.8-flash',
  temperature: 0.6,
  maxOutputTokens: 512,
  timeoutMs: 8000,
};

function fakeGeminiResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('GeminiProvider', () => {
  beforeEach(() => {
    mocks.ssrfSafeFetch.mockReset();
  });

  it('calls the Gemini REST endpoint with the API key in a header, never in the URL', async () => {
    mocks.ssrfSafeFetch.mockResolvedValue(
      fakeGeminiResponse({
        candidates: [{ content: { parts: [{ text: '{"reply":"hello"}' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      }),
    );

    const provider = new GeminiProvider(CONFIG);
    const result = await provider.generateStructured({
      systemInstruction: 'be nice',
      prompt: 'hi',
      schemaName: 'test',
    });

    expect(result.json).toEqual({ reply: 'hello' });
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    const [url, allowedHosts, options] = mocks.ssrfSafeFetch.mock.calls[0] as [
      string,
      string[],
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    );
    expect(allowedHosts).toEqual(['generativelanguage.googleapis.com']);
    expect(url).not.toContain('test-key');
    expect(options.headers['x-goog-api-key']).toBe('test-key');
  });

  it('throws UPSTREAM_UNAVAILABLE when Gemini responds with a non-ok status', async () => {
    mocks.ssrfSafeFetch.mockResolvedValue(fakeGeminiResponse({}, false, 500));
    const provider = new GeminiProvider(CONFIG);

    await expect(
      provider.generateStructured({ systemInstruction: 'x', prompt: 'x', schemaName: 'test' }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('throws AI_RESPONSE_INVALID when the request was safety-blocked', async () => {
    mocks.ssrfSafeFetch.mockResolvedValue(
      fakeGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
    );
    const provider = new GeminiProvider(CONFIG);

    await expect(
      provider.generateStructured({ systemInstruction: 'x', prompt: 'x', schemaName: 'test' }),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
  });

  it('throws AI_RESPONSE_INVALID when there are no candidates', async () => {
    mocks.ssrfSafeFetch.mockResolvedValue(fakeGeminiResponse({ candidates: [] }));
    const provider = new GeminiProvider(CONFIG);

    await expect(
      provider.generateStructured({ systemInstruction: 'x', prompt: 'x', schemaName: 'test' }),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
  });

  it('throws AI_RESPONSE_INVALID when the model text is not valid JSON', async () => {
    mocks.ssrfSafeFetch.mockResolvedValue(
      fakeGeminiResponse({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }),
    );
    const provider = new GeminiProvider(CONFIG);

    await expect(
      provider.generateStructured({ systemInstruction: 'x', prompt: 'x', schemaName: 'test' }),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
  });

  it('reports CONFIGURED from healthCheck when the model endpoint responds ok', async () => {
    mocks.ssrfSafeFetch.mockResolvedValue(fakeGeminiResponse({}));
    const provider = new GeminiProvider(CONFIG);
    await expect(provider.healthCheck()).resolves.toBe('CONFIGURED');
  });

  it('reports UNAVAILABLE from healthCheck when the call throws', async () => {
    mocks.ssrfSafeFetch.mockRejectedValue(new Error('network down'));
    const provider = new GeminiProvider(CONFIG);
    await expect(provider.healthCheck()).resolves.toBe('UNAVAILABLE');
  });
});

describe('createAIProvider', () => {
  it('returns NotConfiguredProvider and NOT_CONFIGURED when GEMINI_API_KEY is unset', () => {
    const { provider, status } = createAIProvider({
      GEMINI_API_KEY: undefined,
      GEMINI_MODEL_ID: 'gemini-3.8-flash',
      GEMINI_TEMPERATURE: 0.6,
      GEMINI_MAX_OUTPUT_TOKENS: 512,
      GEMINI_TIMEOUT_MS: 8000,
    });
    expect(status).toBe('NOT_CONFIGURED');
    expect(provider).toBeInstanceOf(NotConfiguredProvider);
  });

  it('returns a resilience-wrapped GeminiProvider and CONFIGURED when the key is set', () => {
    const { provider, status } = createAIProvider({
      GEMINI_API_KEY: 'test-key',
      GEMINI_MODEL_ID: 'gemini-3.8-flash',
      GEMINI_TEMPERATURE: 0.6,
      GEMINI_MAX_OUTPUT_TOKENS: 512,
      GEMINI_TIMEOUT_MS: 8000,
    });
    expect(status).toBe('CONFIGURED');
    expect(provider).toBeInstanceOf(ResilientAIProvider);
  });
});
