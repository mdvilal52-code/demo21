import { AppError } from '@ai-concierge/domain';
import type { AIProvider, ToolConversationTurn } from '../provider.js';
import type {
  EngineExecutionContext,
  EngineFunction,
  EngineState,
} from './types.js';

export interface ConversationEngineOptions {
  provider: AIProvider;
  functions: readonly EngineFunction[];
  /** Persona + hard rules (e.g. "never invent a price") — kept out of user content, same convention as `GenerateStructuredInput.systemInstruction`. */
  systemInstruction: string;
}

export interface EngineHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ConversationEngineTurnResult {
  reply: string;
  /** The function the model chose this turn, or null if it replied directly without calling one. */
  intent: string | null;
  /** Whatever the chosen function's `execute` returned as `data` — empty when no function ran. */
  data: Record<string, unknown>;
  state: EngineState;
}

const MAX_HISTORY_TURNS = 12;

/**
 * The four-part engine: Gemini's native function-calling does Intent
 * Classification (which function fits this message) and Requirement
 * Extraction (that function's arguments) in one call; `EngineFunction.
 * validateArgs`/`execute` is the Function Calling step; `EngineState` is the
 * Conversation State, threaded in and back out by the caller every turn.
 *
 * Deliberately provider-driven, not a state machine of its own — unlike
 * `packages/workflow`'s `JourneyState` machine (Steps 1-8's deterministic
 * pipeline), this is a thin dispatcher for turns that pipeline doesn't own
 * (see `apps/api/src/services/engine/functions.ts`'s `continue_booking_flow`,
 * which simply hands off to that existing pipeline). It must never grow a
 * second, competing way to decide dates/vehicle/price/eligibility.
 */
export class ConversationEngine {
  constructor(private readonly options: ConversationEngineOptions) {}

  async handleMessage(
    history: readonly EngineHistoryTurn[],
    message: string,
    state: EngineState,
    execCtx: EngineExecutionContext,
  ): Promise<ConversationEngineTurnResult> {
    const provider = this.options.provider;
    if (!provider.generateWithTools) {
      throw new AppError(
        'NOT_CONFIGURED',
        'The configured AI provider does not support function calling',
      );
    }

    const tools = this.options.functions.map((fn) => fn.declaration);
    const contents: ToolConversationTurn[] = [
      ...history.slice(-MAX_HISTORY_TURNS).map((turn): ToolConversationTurn => ({
        role: 'user',
        text: turn.role === 'assistant' ? `[concierge]: ${turn.text}` : turn.text,
      })),
      { role: 'user', text: message },
    ];

    const first = await provider.generateWithTools({
      systemInstruction: this.options.systemInstruction,
      contents,
      tools,
      temperature: 0,
    });

    const advance = (intent: string | null): EngineState => ({
      turnCount: state.turnCount + 1,
      lastIntent: intent,
      collectedSlots: state.collectedSlots,
    });

    if (!first.functionCall) {
      return {
        reply: first.text?.trim() || "Sorry, could you say that a different way?",
        intent: null,
        data: {},
        state: advance(state.lastIntent),
      };
    }

    const fn = this.options.functions.find((f) => f.declaration.name === first.functionCall!.name);
    if (!fn) {
      return {
        reply: "Sorry, I'm not able to help with that here.",
        intent: null,
        data: {},
        state: advance(state.lastIntent),
      };
    }

    const validated = fn.validateArgs(first.functionCall.args, execCtx);
    if (!validated.valid) {
      return {
        reply: `I need a bit more detail before I can help with that: ${validated.reason}`,
        intent: fn.declaration.name,
        data: {},
        state: advance(fn.declaration.name),
      };
    }

    const result = await fn.execute(validated.args, execCtx);

    if (result.finalReply !== undefined) {
      return {
        reply: result.finalReply,
        intent: fn.declaration.name,
        data: result.data ?? {},
        state: advance(fn.declaration.name),
      };
    }

    // A second call grounds the reply's wording in what the function actually
    // did/found (`result`) — the model narrates a verified outcome, it never
    // gets to state one itself. If this call fails or declines to speak,
    // `result.message` (deterministic, function-owned) is the reply instead.
    let reply = result.message;
    try {
      const second = await provider.generateWithTools({
        systemInstruction: this.options.systemInstruction,
        contents: [
          ...contents,
          { role: 'model', functionCall: first.functionCall },
          {
            role: 'user',
            functionResponse: {
              name: fn.declaration.name,
              response: { ok: result.ok, message: result.message, ...(result.data ?? {}) },
            },
          },
        ],
        tools,
        temperature: 0.3,
      });
      if (second.text?.trim()) reply = second.text.trim();
    } catch {
      // Keep the deterministic `result.message` — a reply-wording failure must never surface as an error to the customer.
    }

    return {
      reply,
      intent: fn.declaration.name,
      data: result.data ?? {},
      state: advance(fn.declaration.name),
    };
  }
}
