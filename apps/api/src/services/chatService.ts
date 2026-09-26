import { createHash } from 'node:crypto';
import type {
  ChatBooking,
  ChatMessage,
  ChatQuote,
  ChatState,
  GetChatSessionResponse,
  SendChatMessageBody,
  SendChatMessageResponse,
} from '@ai-concierge/contracts';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  createOutboundMessage,
  findIdempotencyKey,
  findJourneyByConversationId,
  findLatestCollectedBookingInfo,
  findLatestQuoteForConversation,
  findMessagesForConversation,
  findOutboundMessagesForConversation,
  listRecentConversationsForCustomer,
  releaseIdempotencyKeyClaim,
  toDomainQuoteSnapshot,
  type PrismaClient,
} from '@ai-concierge/db';
import {
  AppError,
  JourneyState,
  collectedBookingInfoSchema,
  type QuoteSnapshot,
  type TenantId,
} from '@ai-concierge/domain';
import type { AppContext } from '../context.js';
import { enforceChatLimits } from '../lib/chatLimiter.js';
import { flagUnexpectedPiiInOutboundText } from '../lib/dlp.js';
import { handleInboundTurn } from './conversationTurnService.js';

const CHANNEL = 'WEB' as const;
/** How many of a customer's most recent conversations the chat history shows. */
const HISTORY_CONVERSATIONS = 5;
const HISTORY_MESSAGES_PER_CONVERSATION = 300;

/** A web chat customer is identified only by the random session id their browser made up. */
export function customerRefForSession(sessionId: string): string {
  return `web:${sessionId}`;
}

/** The customer-facing view of a quote: every price line, nothing internal (no integrity hash, no review notes). */
export function toChatQuote(snapshot: QuoteSnapshot): ChatQuote {
  return {
    quoteId: snapshot.quoteId,
    status: snapshot.status,
    currency: snapshot.currency,
    lineItems: snapshot.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitAmount: item.unitAmount,
      amount: item.amount,
    })),
    taxes: snapshot.taxes.map((tax) => ({ description: tax.description, amount: tax.amount })),
    fees: snapshot.fees.map((fee) => ({ description: fee.description, amount: fee.amount })),
    discounts: snapshot.discounts.map((discount) => ({
      description: discount.description,
      amount: discount.amount,
    })),
    deposit: snapshot.deposit,
    total: snapshot.total,
    validUntil: snapshot.validUntil,
  };
}

async function buildChatState(
  prisma: PrismaClient,
  tenantId: TenantId,
  conversationId: string | null,
): Promise<ChatState> {
  if (!conversationId) {
    return {
      conversationId: null,
      journeyState: null,
      escalated: false,
      booking: null,
      quote: null,
    };
  }
  const [journey, collectedRaw, quoteRow] = await Promise.all([
    findJourneyByConversationId(prisma, tenantId, conversationId),
    findLatestCollectedBookingInfo(prisma, tenantId, conversationId),
    findLatestQuoteForConversation(prisma, tenantId, conversationId),
  ]);

  const collected = collectedBookingInfoSchema.safeParse(collectedRaw);
  const booking: ChatBooking | null = collected.success
    ? {
        vehicle: collected.data.vehicle
          ? `${collected.data.vehicle.make} ${collected.data.vehicle.model}`
          : null,
        pickupDate: collected.data.pickupDate,
        returnDate: collected.data.returnDate,
        pickupLocation: collected.data.pickupLocation?.normalized ?? null,
      }
    : null;

  return {
    conversationId,
    journeyState: journey?.state ?? null,
    escalated: journey?.state === JourneyState.ESCALATED,
    booking,
    quote: quoteRow ? toChatQuote(toDomainQuoteSnapshot(quoteRow)) : null,
  };
}

/**
 * One customer message in the website chat. Runs exactly the same
 * `handleInboundTurn` as WhatsApp and Email — Steps 1-4, the automatic Steps
 * 5-8 chain, human hand-off, the Gemini-worded grounded reply — so the web
 * chat is a full concierge channel, not a demo. The reply comes straight back
 * in the response (no provider to call) and is stored as the concierge's turn.
 *
 * `clientMessageId` makes a double-tap or a network retry harmless: the same
 * id replays the stored reply instead of running the pipeline twice.
 */
export async function sendChatMessage(
  ctx: AppContext,
  body: SendChatMessageBody,
  requestId: string,
): Promise<SendChatMessageResponse> {
  const tenantId = ctx.config.DEFAULT_TENANT_ID;
  await enforceChatLimits(ctx.redis, body.sessionId, {
    perSessionPer10Min: ctx.config.CHAT_SESSION_LIMIT_PER_10_MIN,
    globalPerMin: ctx.config.CHAT_GLOBAL_LIMIT_PER_MIN,
  });

  const idempotencyKey = `chat:${body.sessionId}:${body.clientMessageId}`;
  const claimed = await claimIdempotencyKey(ctx.prisma, {
    key: idempotencyKey,
    tenantId,
    requestHash: createHash('sha256').update(body.message).digest('hex'),
  });
  if (!claimed) {
    const stored = await findIdempotencyKey(ctx.prisma, idempotencyKey);
    if (stored?.responseBody) return stored.responseBody as SendChatMessageResponse;
    throw new AppError('CONFLICT', 'This message is still being processed');
  }

  try {
    const turn = await handleInboundTurn(ctx, {
      channel: CHANNEL,
      customerRef: customerRefForSession(body.sessionId),
      body: body.message,
      requestId,
    });

    await flagUnexpectedPiiInOutboundText(
      { prisma: ctx.prisma, logger: ctx.logger },
      { tenantId, channel: CHANNEL, text: turn.reply.text },
    );
    const source = turn.reply.source === 'AI_GENERATED' ? 'AI_GENERATED' : 'TEMPLATE';
    const stored = await createOutboundMessage(ctx.prisma, {
      tenantId,
      conversationId: turn.conversationId,
      content: turn.reply.text,
      source,
      stage: turn.reply.stage,
    });

    const state = await buildChatState(ctx.prisma, tenantId, turn.conversationId);
    const response: SendChatMessageResponse = {
      ...state,
      reply: {
        id: stored.id,
        text: turn.reply.text,
        source,
        createdAt: stored.createdAt.toISOString(),
      },
    };
    await completeIdempotencyKey(ctx.prisma, idempotencyKey, 200, response);
    return response;
  } catch (error) {
    await releaseIdempotencyKeyClaim(ctx.prisma, idempotencyKey);
    throw error;
  }
}

/**
 * The chat as the customer left it: their recent conversations merged into
 * one thread (including anything a staff member wrote), plus the current
 * booking summary and quote. The chat page polls this while open, which is how
 * a human worker's reply appears without a page reload.
 */
export async function getChatSession(
  ctx: AppContext,
  sessionId: string,
): Promise<GetChatSessionResponse> {
  const tenantId = ctx.config.DEFAULT_TENANT_ID;
  const conversations = await listRecentConversationsForCustomer(
    ctx.prisma,
    tenantId,
    CHANNEL,
    customerRefForSession(sessionId),
    HISTORY_CONVERSATIONS,
  );

  const threads = await Promise.all(
    conversations.map(async (conversation) => {
      const [customerMessages, outbound] = await Promise.all([
        findMessagesForConversation(ctx.prisma, tenantId, conversation.id),
        findOutboundMessagesForConversation(
          ctx.prisma,
          tenantId,
          conversation.id,
          HISTORY_MESSAGES_PER_CONVERSATION,
        ),
      ]);
      return [
        ...customerMessages.map((row): ChatMessage => ({
          id: row.id,
          role: 'CUSTOMER',
          content: row.content,
          createdAt: row.createdAt.toISOString(),
        })),
        ...outbound.map((row): ChatMessage => ({
          id: row.id,
          role: row.source === 'HUMAN' ? 'STAFF' : 'CONCIERGE',
          content: row.content,
          createdAt: row.createdAt.toISOString(),
        })),
      ];
    }),
  );

  const messages = threads.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const state = await buildChatState(ctx.prisma, tenantId, conversations[0]?.id ?? null);
  return { ...state, messages };
}
