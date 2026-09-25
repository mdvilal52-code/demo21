import { findMessagesForConversation, type PrismaClient } from '@ai-concierge/db';
import type { TenantId } from '@ai-concierge/domain';

/**
 * Generous safety valve, not a realistic conversation length. Steps 2-3's
 * extractors are cheap deterministic regex passes, so correctness — never
 * losing an early turn's vehicle/date/location once the conversation runs
 * long — matters far more here than trimming input size. Contrast with
 * `MAX_RECENT_TURNS_FOR_REPLY` (conversationalReplyService.ts), a much
 * smaller window used only for the Gemini prompt, where token cost/latency
 * genuinely justifies a tight cap.
 */
export const MAX_TRANSCRIPT_MESSAGES = 200;

/** Pure — for callers that already fetched the message list themselves (see whatsappService.ts). */
export function joinTranscript(messages: Array<{ content: string }>): string {
  return messages.map((message) => message.content).join('\n');
}

/**
 * Joins the conversation's turns into one block of text so Steps 2-3's
 * extractors see everything the customer has said so far, not just the
 * newest message — e.g. "actually, make it 5 days" alone has no vehicle or
 * location in it, but combined with turn 1 it does. Each extractor's own
 * `sanitizeForProcessing` still runs on the combined text, so this doesn't
 * bypass prompt-injection handling.
 *
 * Not a substitute for real contradiction resolution: if two turns state
 * conflicting dates, the regex-based extractor may match either one — see
 * docs/phases/PHASE-06.md §3 for why "latest value wins" merging is
 * deliberately out of scope this phase.
 */
export async function buildConversationTranscript(
  prisma: PrismaClient,
  tenantId: TenantId,
  conversationId: string,
): Promise<string> {
  const messages = await findMessagesForConversation(prisma, tenantId, conversationId, {
    limit: MAX_TRANSCRIPT_MESSAGES,
  });
  return joinTranscript(messages);
}
