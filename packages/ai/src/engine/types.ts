import type { ToolDeclaration } from '../provider.js';

/**
 * Persisted between turns of one conversation (stored by the caller —
 * this package never touches a database — typically under a Journey's
 * existing `context` JSON column, see `apps/api`'s `engineChatService.ts`).
 */
export interface EngineState {
  turnCount: number;
  lastIntent: string | null;
  /** Free-form, function-owned facts collected across turns (e.g. a partially given escalation reason). */
  collectedSlots: Record<string, unknown>;
}

export function createInitialEngineState(): EngineState {
  return { turnCount: 0, lastIntent: null, collectedSlots: {} };
}

export interface EngineFunctionResult {
  ok: boolean;
  /** Grounded facts the reply-wording model call may reference — never invented, always what `execute` actually did/found. */
  data?: Record<string, unknown>;
  /** A plain-language summary of the outcome, used as the reply if the provider has no `generateWithTools` text turn left, or on failure. */
  message: string;
  /**
   * When set, the engine returns this verbatim and skips the second
   * "ground the reply" model call entirely. For a function that already
   * produced a customer-safe reply through its own trusted path (e.g.
   * `continue_booking_flow` handing off to the existing Steps 1-8 pipeline,
   * which already words its own Gemini-grounded reply) — letting a second,
   * unrelated model call re-word an already-correct reply is pure
   * regression risk for zero benefit.
   */
  finalReply?: string;
}

export interface EngineExecutionContext {
  tenantId: string;
  conversationId: string;
  /** The customer's own message text this turn, for evidence-quote checks in `validateArgs`. */
  rawMessage: string;
  now: Date;
}

export type ArgValidationResult =
  | { valid: true; args: Record<string, unknown> }
  | { valid: false; reason: string };

/**
 * One callable capability the engine can dispatch to. `validateArgs` is
 * mandatory and runs on every model-proposed call before `execute` ever
 * sees it — "never trust AI output" (see `packages/ai/src/step5/intake/
 * geminiIntakeExtractor.ts`) applies here exactly as it does to Step 5's
 * intake extraction: the model may *propose* a function and its arguments,
 * it never gets to decide they are correct.
 */
export interface EngineFunction {
  readonly declaration: ToolDeclaration;
  validateArgs(raw: Record<string, unknown>, ctx: EngineExecutionContext): ArgValidationResult;
  execute(args: Record<string, unknown>, ctx: EngineExecutionContext): Promise<EngineFunctionResult>;
}
