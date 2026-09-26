import type {
  AIProvider,
  AIProviderHealth,
  GenerateStructuredInput,
  GenerateStructuredResult,
} from '@ai-concierge/ai';
import { NotConfiguredProvider, ResilientAIProvider } from '@ai-concierge/ai';
import { ssrfSafeFetch } from '@ai-concierge/security';
import { AppError } from '@ai-concierge/domain';
import type { ApiEnv } from '../env.js';

const GEMINI_API_HOST = 'generativelanguage.googleapis.com';
const GEMINI_API_VERSION = 'v1beta';

export interface GeminiProviderConfig {
  apiKey: string;
  modelId: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /**
   * How hard the model thinks before answering. Thinking tokens count against
   * maxOutputTokens, so a lower level is what keeps a short JSON reply from being
   * truncated (and is cheaper and faster). Unset sends no thinkingConfig at all.
   */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Direct REST adapter for the Gemini API (no SDK — same convention as
 * `MetaCloudApiWhatsAppClient`: one `ssrfSafeFetch` call against a single
 * hardcoded host). Never called directly from business logic; always wrapped
 * in `ResilientAIProvider` (see `createAIProvider` below) so callers get
 * timeout/circuit-breaker/rate-limit for free.
 */
export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  /** Set once the API rejects `thinkingConfig` for this model — later calls then omit it. */
  private thinkingUnsupported = false;

  constructor(private readonly config: GeminiProviderConfig) {}

  async generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult> {
    const startedAt = Date.now();
    const url = `https://${GEMINI_API_HOST}/${GEMINI_API_VERSION}/models/${this.config.modelId}:generateContent`;

    const send = (includeThinking: boolean) =>
      ssrfSafeFetch(url, [GEMINI_API_HOST], {
        method: 'POST',
        timeoutMs: input.timeoutMs ?? this.config.timeoutMs,
        headers: {
          'x-goog-api-key': this.config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
          systemInstruction: { parts: [{ text: input.systemInstruction }] },
          generationConfig: {
            temperature: input.temperature ?? this.config.temperature,
            maxOutputTokens: input.maxOutputTokens ?? this.config.maxOutputTokens,
            responseMimeType: 'application/json',
            ...(input.responseSchema ? { responseSchema: input.responseSchema } : {}),
            ...(includeThinking && this.config.thinkingLevel
              ? { thinkingConfig: { thinkingLevel: this.config.thinkingLevel } }
              : {}),
          },
        }),
      });

    const includeThinking = Boolean(this.config.thinkingLevel) && !this.thinkingUnsupported;
    let response = await send(includeThinking);

    // A model that does not accept `thinkingConfig` answers 400 naming it. That
    // must never take the whole reply engine down: remember it and retry once
    // without the field, so the call — and every later one — still succeeds.
    let errorBody = '';
    if (!response.ok && includeThinking && response.status === 400) {
      errorBody = await response.text().catch(() => '');
      if (/thinking/i.test(errorBody)) {
        this.thinkingUnsupported = true;
        response = await send(false);
        errorBody = '';
      }
    }

    if (!response.ok) {
      errorBody = errorBody || (await response.text().catch(() => ''));
      throw new AppError('UPSTREAM_UNAVAILABLE', 'Gemini request failed', {
        details: { status: response.status, schemaName: input.schemaName },
        cause: errorBody,
      });
    }

    const data = (await response.json()) as GeminiGenerateContentResponse;

    if (data.promptFeedback?.blockReason) {
      throw new AppError('AI_RESPONSE_INVALID', 'Gemini blocked the request', {
        details: { blockReason: data.promptFeedback.blockReason, schemaName: input.schemaName },
      });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new AppError('AI_RESPONSE_INVALID', 'Gemini returned no content', {
        details: {
          finishReason: data.candidates?.[0]?.finishReason,
          schemaName: input.schemaName,
        },
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new AppError('AI_RESPONSE_INVALID', 'Gemini response was not valid JSON', {
        details: { schemaName: input.schemaName },
        cause,
      });
    }

    return {
      json,
      usage: {
        promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
      },
      modelId: this.config.modelId,
      latencyMs: Date.now() - startedAt,
    };
  }

  async healthCheck(): Promise<AIProviderHealth> {
    try {
      const url = `https://${GEMINI_API_HOST}/${GEMINI_API_VERSION}/models/${this.config.modelId}`;
      const response = await ssrfSafeFetch(url, [GEMINI_API_HOST], {
        method: 'GET',
        timeoutMs: 5000,
        headers: { 'x-goog-api-key': this.config.apiKey },
      });
      return response.ok ? 'CONFIGURED' : 'UNAVAILABLE';
    } catch {
      return 'UNAVAILABLE';
    }
  }
}

export type GeminiConfig = Pick<
  ApiEnv,
  | 'GEMINI_API_KEY'
  | 'GEMINI_MODEL_ID'
  | 'GEMINI_TEMPERATURE'
  | 'GEMINI_MAX_OUTPUT_TOKENS'
  | 'GEMINI_TIMEOUT_MS'
  | 'GEMINI_THINKING_LEVEL'
>;

export interface AIProviderSetup {
  provider: AIProvider;
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
}

/**
 * Only the secret (`GEMINI_API_KEY`) gates CONFIGURED vs NOT_CONFIGURED —
 * unlike WhatsApp's four-vars-or-none rule, model id / temperature / token
 * limit / timeout all have safe defaults and are tuning knobs, not
 * credentials, so a missing one is never treated as "half configured".
 */
export function createAIProvider(config: GeminiConfig): AIProviderSetup {
  if (!config.GEMINI_API_KEY) {
    return { provider: new NotConfiguredProvider(), status: 'NOT_CONFIGURED' };
  }
  const gemini = new GeminiProvider({
    apiKey: config.GEMINI_API_KEY,
    modelId: config.GEMINI_MODEL_ID,
    temperature: config.GEMINI_TEMPERATURE,
    maxOutputTokens: config.GEMINI_MAX_OUTPUT_TOKENS,
    timeoutMs: config.GEMINI_TIMEOUT_MS,
    thinkingLevel: config.GEMINI_THINKING_LEVEL,
  });
  return { provider: new ResilientAIProvider(gemini), status: 'CONFIGURED' };
}
