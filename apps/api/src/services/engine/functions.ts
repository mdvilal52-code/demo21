import type { EngineExecutionContext, EngineFunction } from '@ai-concierge/ai';
import { EscalationReason, EscalationTier } from '@ai-concierge/domain';
import type { AppContext } from '../../context.js';
import type { InboundTurnResult } from '../conversationTurnService.js';
import { escalateJourney } from '../journeyService.js';

export interface EngineFunctionsDeps {
  appCtx: AppContext;
  requestId: string;
}

const MAX_REASON_CHARS = 300;
const MAX_TOPIC_CHARS = 100;

/** Same "never trust AI output" evidence check as `geminiIntakeExtractor.ts`: a proposed fact must be traceable to the customer's own words. */
function quotedInMessage(candidate: string, rawMessage: string): boolean {
  const needle = candidate.toLowerCase().trim();
  return needle.length >= 3 && rawMessage.toLowerCase().includes(needle);
}

/**
 * The default, catch-all function. It does no extraction or decisioning of
 * its own — it hands the turn to `handleInboundTurn`, the same Steps 1-8
 * pipeline every other channel (WhatsApp, Email) already uses, and returns
 * exactly the reply that pipeline already produced (`finalReply`, so the
 * engine's own reply-wording call never touches it). This function existing
 * is what keeps the engine from ever becoming a second, competing way to
 * decide dates/vehicle/price/eligibility.
 */
export function createContinueBookingFlowFunction(turn: InboundTurnResult): EngineFunction {
  return {
    declaration: {
      name: 'continue_booking_flow',
      description:
        'The default for almost every message: dates, pickup/return location, vehicle choice, price or quote questions, documents, or eligibility (license, nationality, age). Use this unless the customer clearly asks to speak to a person, or asks something with nothing to do with renting a car.',
      parameters: { type: 'object', properties: {} },
    },
    validateArgs: () => ({ valid: true, args: {} }),
    async execute() {
      return {
        ok: true,
        message: turn.reply.text,
        finalReply: turn.reply.text,
        data: { conversationId: turn.conversationId, stage: turn.reply.stage },
      };
    },
  };
}

/**
 * Only for an explicit, customer-initiated request for a human — Steps 1-8's
 * own policy-driven escalations (eligibility exceptions, provider failures,
 * stalled info) already happen automatically inside `handleInboundTurn`
 * above and are never re-decided here. Reuses `escalateJourney` verbatim
 * (same tier/case/audit-event/SMS-page path the dashboard's Escalation
 * Queue already expects) instead of writing a second, parallel escalation
 * path against the database.
 */
export function createEscalateToHumanFunction(
  deps: EngineFunctionsDeps,
  turn: InboundTurnResult,
): EngineFunction {
  return {
    declaration: {
      name: 'escalate_to_human',
      description:
        "Use only when the customer explicitly asks to talk to a person, a human, a manager, or says they are done talking to a bot/AI. Do not use this for ordinary frustration about a price or a wait — only an explicit request for a human.",
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: "A short phrase copied from the customer's own message explaining why.",
          },
        },
        required: ['reason'],
      },
    },
    validateArgs(raw, ctx: EngineExecutionContext) {
      const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, MAX_REASON_CHARS) : '';
      if (!reason) return { valid: false, reason: 'a short reason, in your own words' };
      if (!quotedInMessage(reason, ctx.rawMessage)) {
        return { valid: false, reason: 'a reason based on what you actually wrote' };
      }
      return { valid: true, args: { reason } };
    },
    async execute(args, ctx: EngineExecutionContext) {
      const result = await escalateJourney(
        { prisma: deps.appCtx.prisma, notificationProvider: deps.appCtx.notificationProvider },
        {
          tenantId: ctx.tenantId,
          conversationId: ctx.conversationId,
          decision: {
            tier: EscalationTier.T2,
            reason: EscalationReason.AI_UNABLE_TO_PROCEED,
            detail: `Customer asked for a human: ${String(args.reason)}`,
          },
          requestId: deps.requestId,
        },
      );
      // A journey that is already escalated/terminal is a silent no-op in
      // `escalateJourney` (never an error) — the pipeline's own reply already
      // covers that case correctly, so fall back to it rather than repeat
      // a hand-off message for something already handed off.
      const finalReply = result.escalated
        ? "I've flagged this for a member of our team — they'll reach out to you shortly."
        : turn.reply.text;
      return {
        ok: result.escalated,
        message: finalReply,
        finalReply,
        data: { escalationCaseId: result.escalationCaseId, escalated: result.escalated },
      };
    },
  };
}

/**
 * For questions with nothing to do with a specific rental (company info,
 * hours, how to reach support) — deliberately does not answer itself; it
 * only records the topic and lets the engine's own reply-wording model call
 * answer, scoped by the engine's system instruction to general information
 * only. Never used for anything Steps 1-8 should own (see the two functions
 * above's descriptions, which route those away from here).
 */
export function createAnswerGeneralFaqFunction(): EngineFunction {
  return {
    declaration: {
      name: 'answer_general_faq',
      description:
        'Use for a question unrelated to a specific rental — what the company does, operating hours, how to contact support, general policies. Never for anything about dates, price, a specific vehicle, or eligibility documents.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'A short label for what they asked about.' },
        },
        required: ['topic'],
      },
    },
    validateArgs(raw) {
      const topic = typeof raw.topic === 'string' ? raw.topic.trim().slice(0, MAX_TOPIC_CHARS) : '';
      if (!topic) return { valid: false, reason: 'what you were asking about' };
      return { valid: true, args: { topic } };
    },
    async execute(args) {
      return {
        ok: true,
        message: "I'm not sure about that one — let me have someone follow up.",
        data: { topic: args.topic },
      };
    },
  };
}
