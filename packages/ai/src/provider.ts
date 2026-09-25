import { AppError } from '@ai-concierge/domain';

/**
 * Seam for a real LLM provider (Gemini, Anthropic, OpenAI, …). Intent
 * recognition and Steps 2-4 do not use this — they run entirely on
 * deterministic rule-based logic so there is zero network dependency and
 * zero hallucination risk in the business-fact pipeline regardless of
 * whether a provider is configured. This interface is for the conversational
 * reply layer only: phrasing a natural response around facts the
 * deterministic pipeline already verified, never deciding those facts.
 */
export type AIProviderHealth = 'CONFIGURED' | 'NOT_CONFIGURED' | 'UNAVAILABLE';

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GenerateStructuredInput {
  /** Model-level instructions (persona, hard constraints) kept separate from user content. */
  systemInstruction: string;
  /** The user-turn content — callers must sanitize/bound this before it reaches here. */
  prompt: string;
  /** Label only, for logging/telemetry — not enforced by this interface. */
  schemaName: string;
  /** Provider-specific JSON-schema hint for constrained decoding, when supported. */
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface GenerateStructuredResult {
  /**
   * Parsed JSON, deliberately typed `unknown` — this interface never
   * promises the shape is correct. Callers MUST validate with their own Zod
   * schema before trusting anything in here (never trust AI output).
   */
  json: unknown;
  usage: AIUsage;
  modelId: string;
  latencyMs: number;
}

export interface AIProvider {
  readonly name: string;
  generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult>;
  healthCheck(): Promise<AIProviderHealth>;
}

export class NotConfiguredProvider implements AIProvider {
  readonly name = 'not-configured';

  async generateStructured(): Promise<GenerateStructuredResult> {
    throw new AppError('NOT_CONFIGURED', 'No AI provider is configured for this environment');
  }

  async healthCheck(): Promise<AIProviderHealth> {
    return 'NOT_CONFIGURED';
  }
}
