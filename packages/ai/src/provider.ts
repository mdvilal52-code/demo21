import { AppError } from '@ai-concierge/domain';

/**
 * Seam for a real LLM provider (Anthropic, OpenAI, …) — not yet wired to any
 * step. Phases 1-4 all turned out deterministic (`RuleBasedIntentEngine`,
 * Step 2-4's regex/gazetteer/lexicon-based services) so there is zero
 * network dependency and zero hallucination risk while no provider is
 * configured. This interface exists now so whichever future phase needs a
 * real LLM implements an adapter rather than inventing the seam under
 * deadline pressure.
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
