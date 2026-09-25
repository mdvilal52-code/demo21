import { MissingInfoStatus, type MissingInfoResult } from '@ai-concierge/domain';

/**
 * Body text is deliberately the exact same deterministic template
 * WhatsApp's `buildWhatsAppReplyText` already produces — the content is
 * channel-agnostic (MissingInfoResult, not WhatsApp's payload shape), so
 * reusing it keeps replies consistent across channels instead of forking
 * the same zero-hallucination logic twice. See
 * `apps/api/src/services/conversationalReplyService.ts` for where the
 * Gemini-generated reply (grounded in this same result) supersedes this
 * fallback when the AI provider is configured and healthy — unchanged by
 * this file, and equally available to the Email channel.
 */
export { buildWhatsAppReplyText as buildEmailReplyBody } from '../whatsapp/replyBuilder.js';

const SUBJECT_BY_STATUS: Record<MissingInfoResult['status'], string> = {
  [MissingInfoStatus.COMPLETE]: 'Your rental enquiry — got everything we need',
  [MissingInfoStatus.NEEDS_INFO]: 'A few more details for your rental enquiry',
  [MissingInfoStatus.EXPIRED]: 'Your rental enquiry has expired',
  [MissingInfoStatus.NOT_APPLICABLE]: 'Thanks for reaching out',
  [MissingInfoStatus.CANCELLED]: 'Your booking request was cancelled',
};

export function buildEmailReplySubject(missingInfo: MissingInfoResult): string {
  return SUBJECT_BY_STATUS[missingInfo.status];
}
