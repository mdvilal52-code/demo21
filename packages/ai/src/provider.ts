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

/** One callable tool a `generateWithTools` call may pick — the model never sees more than name/description/parameters. */
export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON-schema-shaped parameter spec (same subset Gemini's function-calling accepts). */
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** One turn of the tool-calling conversation sent back to the model as history. */
export type ToolConversationTurn =
  | { role: 'user'; text: string }
  | { role: 'model'; functionCall: { name: string; args: Record<string, unknown> } }
  | { role: 'user'; functionResponse: { name: string; response: Record<string, unknown> } };

export interface GenerateWithToolsInput {
  systemInstruction: string;
  /** Conversation so far, oldest first — the caller owns trimming/windowing. */
  contents: ToolConversationTurn[];
  tools: ToolDeclaration[];
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface GenerateWithToolsResult {
  /** Set when the model chose a tool instead of replying in plain text. */
  functionCall?: { name: string; args: Record<string, unknown> };
  /** Set when the model replied in plain text instead of calling a tool. */
  text?: string;
  usage: AIUsage;
  modelId: string;
  latencyMs: number;
}

export interface AIProvider {
  readonly name: string;
  generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult>;
  healthCheck(): Promise<AIProviderHealth>;
  /**
   * Native function-calling, for the intent-classification/function-dispatch
   * engine only (see `@ai-concierge/ai`'s `engine/` module) — optional
   * because most providers/call sites only ever need `generateStructured`.
   * Steps 2-8's business-fact pipeline must never depend on this existing.
   */
  generateWithTools?(input: GenerateWithToolsInput): Promise<GenerateWithToolsResult>;
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
