import { createHash } from 'node:crypto';
import type { SendEngineMessageBody, SendEngineMessageResponse } from '@ai-concierge/contracts';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  findIdempotencyKey,
  releaseIdempotencyKeyClaim,
} from '@ai-concierge/db';
import {
  ConversationEngine,
  createInitialEngineState,
  type EngineExecutionContext,
  type EngineState,
} from '@ai-concierge/ai';
import { AppError } from '@ai-concierge/domain';
import type { AppContext } from '../context.js';
import { enforceChatLimits } from '../lib/chatLimiter.js';
import { customerRefForSession } from './chatService.js';
import { handleInboundTurn } from './conversationTurnService.js';
import {
  createAnswerGeneralFaqFunction,
  createContinueBookingFlowFunction,
  createEscalateToHumanFunction,
} from './engine/functions.js';

const CHANNEL = 'WEB' as const;
/** Long enough to span a normal booking conversation; state is a UX nicety (which function ran last), never a fact Steps 1-8 rely on. */
const ENGINE_STATE_TTL_SECONDS = 60 * 60 * 24;
const ENGINE_STATE_KEY_PREFIX = 'engine:state:';

const SYSTEM_INSTRUCTION = `
You are the front-door classifier for a luxury car-rental concierge chat.

On every customer message, call exactly one of the functions you are given —
never reply in plain text on your first turn. Pick "continue_booking_flow"
for almost everything: dates, locations, vehicles, prices, documents,
eligibility. Only pick "escalate_to_human" when the customer explicitly asks
for a person. Only pick "answer_general_faq" for a question that has nothing
to do with a specific rental.

When you are then given that function's result, word one short, natural
customer-facing reply grounded ONLY in facts present in that result. Never
invent a price, date, availability, or policy detail that is not there.
`.trim();

/**
 * Persisted turn count / last-intent only — never a fact Steps 1-8 need, so
 * Redis (already used for idempotency/rate-limiting in this file's sibling
 * `chatService.ts`) is the right store: no optimistic-locking/version
 * semantics to respect, unlike `Journey.context`.
 */
async function loadEngineState(ctx: AppContext, conversationId: string): Promise<EngineState> {
  const raw = await ctx.redis.get(ENGINE_STATE_KEY_PREFIX + conversationId);
  if (!raw) return createInitialEngineState();
  try {
    return JSON.parse(raw) as EngineState;
  } catch {
    return createInitialEngineState();
  }
}

async function saveEngineState(
  ctx: AppContext,
  conversationId: string,
  state: EngineState,
): Promise<void> {
  await ctx.redis.set(
    ENGINE_STATE_KEY_PREFIX + conversationId,
    JSON.stringify(state),
    'EX',
    ENGINE_STATE_TTL_SECONDS,
  );
}

function toContractIntent(intent: string | null): SendEngineMessageResponse['intent'] {
  switch (intent) {
    case 'continue_booking_flow':
      return 'CONTINUE_BOOKING_FLOW';
    case 'escalate_to_human':
      return 'ESCALATE_TO_HUMAN';
    case 'answer_general_faq':
      return 'ANSWER_GENERAL_FAQ';
    default:
      return null;
  }
}

/**
 * The Gemini function-calling front door — Intent Classification +
 * Requirement Extraction + Function Calling + Conversation State, additive
 * to (never a replacement for) `chatService.sendChatMessage`. Every message
 * still runs `handleInboundTurn` first, exactly as the WhatsApp/Email/web
 * chat channels already do, so Steps 1-8's booking/pricing/eligibility
 * decisions are made exactly once, in exactly one place, regardless of which
 * endpoint the customer's message came in through. This engine only ever
 * layers on top: an explicit hand-off to a human, or a reply to a question
 * the booking pipeline was never meant to answer.
 */
export async function sendEngineMessage(
  ctx: AppContext,
  body: SendEngineMessageBody,
  requestId: string,
): Promise<SendEngineMessageResponse> {
  const tenantId = ctx.config.DEFAULT_TENANT_ID;
  await enforceChatLimits(ctx.redis, body.sessionId, {
    perSessionPer10Min: ctx.config.CHAT_SESSION_LIMIT_PER_10_MIN,
    globalPerMin: ctx.config.CHAT_GLOBAL_LIMIT_PER_MIN,
  });

  if (!ctx.aiProvider.generateWithTools) {
    throw new AppError(
      'NOT_CONFIGURED',
      'This engine requires an AI provider that supports function calling',
    );
  }

  const idempotencyKey = `engine:${body.sessionId}:${body.clientMessageId}`;
  const claimed = await claimIdempotencyKey(ctx.prisma, {
    key: idempotencyKey,
    tenantId,
    requestHash: createHash('sha256').update(body.message).digest('hex'),
  });
  if (!claimed) {
    const stored = await findIdempotencyKey(ctx.prisma, idempotencyKey);
    if (stored?.responseBody) return stored.responseBody as SendEngineMessageResponse;
    throw new AppError('CONFLICT', 'This message is still being processed');
  }

  try {
    const turn = await handleInboundTurn(ctx, {
      channel: CHANNEL,
      customerRef: customerRefForSession(body.sessionId),
      body: body.message,
      requestId,
    });

    const engine = new ConversationEngine({
      provider: ctx.aiProvider,
      systemInstruction: SYSTEM_INSTRUCTION,
      functions: [
        createContinueBookingFlowFunction(turn),
        createEscalateToHumanFunction({ appCtx: ctx, requestId }, turn),
        createAnswerGeneralFaqFunction(),
      ],
    });

    const state = await loadEngineState(ctx, turn.conversationId);
    const execCtx: EngineExecutionContext = {
      tenantId,
      conversationId: turn.conversationId,
      rawMessage: body.message,
      now: new Date(),
    };

    // `handleInboundTurn` above already produced a safe reply (its own
    // Gemini call has the same "fall back to a deterministic draft" pattern
    // journeyReplyService.ts uses everywhere else) — if the *classifier*
    // call fails (rate limit, timeout, upstream outage), the customer must
    // still get that reply, never a 502. This mirrors the exact resilience
    // posture the rest of this codebase already has for every other Gemini
    // call site; it must not be the one place a Gemini hiccup becomes a
    // visible failure.
    let response: SendEngineMessageResponse;
    try {
      const result = await engine.handleMessage([], body.message, state, execCtx);
      await saveEngineState(ctx, turn.conversationId, result.state);
      response = {
        conversationId: turn.conversationId,
        intent: toContractIntent(result.intent),
        reply: { text: result.reply, createdAt: new Date().toISOString() },
        escalated: result.intent === 'escalate_to_human' && result.data.escalated === true,
      };
    } catch (engineError) {
      ctx.logger.warn(
        { err: engineError },
        'conversation engine classification failed, falling back to the booking pipeline reply',
      );
      response = {
        conversationId: turn.conversationId,
        intent: null,
        reply: { text: turn.reply.text, createdAt: new Date().toISOString() },
        escalated: false,
      };
    }
    await completeIdempotencyKey(ctx.prisma, idempotencyKey, 200, response);
    return response;
  } catch (error) {
    await releaseIdempotencyKeyClaim(ctx.prisma, idempotencyKey);
    throw error;
  }
}
