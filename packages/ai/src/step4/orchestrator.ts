import {
  MISSING_INFO_TIMEOUT_HOURS,
  MissingInfoStatus,
  missingInfoResultSchema,
  type MissingInfoResult,
} from '@ai-concierge/domain';
import { buildClarificationPrompt } from './clarificationPromptBuilder.js';
import {
  RequiredFieldsEvaluator,
  type RequiredFieldsEvaluationInput,
} from './requiredFieldsEvaluator.js';

/**
 * Step 4 — Ask Missing Information. Unlike Steps 2-3, there is no new raw
 * text to interpret here — every input already went through its own step's
 * "AI proposes, deterministic domain logic verifies" pipeline, so this
 * orchestrator is itself fully synchronous and deterministic: evaluate what's
 * missing, build one combined clarification question, compute the timeout
 * boundary, and Zod-validate before it leaves.
 */
export class MissingInfoOrchestrator {
  private readonly evaluator = new RequiredFieldsEvaluator();

  evaluate(input: RequiredFieldsEvaluationInput): MissingInfoResult {
    const evaluation = this.evaluator.evaluate(input);
    const clarificationPrompt =
      evaluation.status === MissingInfoStatus.NEEDS_INFO
        ? buildClarificationPrompt(evaluation.missingFields)
        : null;
    const expiresAt = new Date(
      input.conversationCreatedAt.getTime() + MISSING_INFO_TIMEOUT_HOURS * 60 * 60 * 1000,
    );

    const result: MissingInfoResult = {
      status: evaluation.status,
      collected: evaluation.collected,
      missingFields: evaluation.missingFields,
      clarificationPrompt,
      expiresAt: expiresAt.toISOString(),
      flags: { promptInjectionDetectedAnywhere: evaluation.promptInjectionDetectedAnywhere },
      modelMetadata: {
        engine: 'missing-info-evaluator-v1',
        version: '0.1.0',
        deterministic: true,
      },
    };

    return missingInfoResultSchema.parse(result);
  }
}
