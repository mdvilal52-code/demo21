import { AppError } from '@ai-concierge/domain';

/**
 * Seam for a real LLM provider (Anthropic, OpenAI, …), wired up in Phase 4.
 * Phase 1's intent recognition does not use this — it runs entirely on
 * `RuleBasedIntentEngine` so there is zero network dependency and zero
 * hallucination risk while no provider is configured. This interface exists
 * now so later phases implement an adapter rather than inventing the seam
 * under deadline pressure.
 */
export interface AIProvider {
  readonly name: string;
  generateStructured<T>(input: { prompt: string; schemaName: string }): Promise<T>;
}

export class NotConfiguredProvider implements AIProvider {
  readonly name = 'not-configured';

  async generateStructured<T>(): Promise<T> {
    throw new AppError('NOT_CONFIGURED', 'No AI provider is configured for this environment');
  }
}
