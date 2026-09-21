/**
 * Deterministic classifier for a short conversational reply (e.g. "Yes",
 * "No thanks", "Sure") — distinct from `classifyIntentType` in
 * `intent-engine.ts`, which classifies what a message is *about* (booking,
 * pricing, support, ...). This classifies whether a message *answers* a
 * yes/no question, which a booking-shaped keyword lexicon has no concept of:
 * "Yes" on its own carries no booking keyword, so without this a short
 * confirmation reply is indistinguishable from a first-contact greeting.
 * Used by the WhatsApp channel adapter's conversation-stage machine
 * (`apps/api/src/services/whatsappConversationState.ts`) to interpret a
 * reply using the conversation's own context (what was last asked) instead
 * of re-deriving meaning from isolated keywords.
 */
export const ShortReplyIntent = {
  AFFIRMATIVE: 'AFFIRMATIVE',
  NEGATIVE: 'NEGATIVE',
  UNCLEAR: 'UNCLEAR',
} as const;

export type ShortReplyIntentValue = (typeof ShortReplyIntent)[keyof typeof ShortReplyIntent];

// Checked first: "no thanks", "not interested" and "not now" all contain a
// word (thanks/interested) that would otherwise look affirmative on its own.
const NEGATIVE_PATTERN =
  /\b(no|nope|nah|never\s*mind|nevermind|cancel|not\s+(now|interested|really|today|yet))\b/i;

// Checked next: "not sure"/"not certain" negate what would otherwise match
// AFFIRMATIVE_PATTERN below ("sure") — genuinely ambiguous, not a plain yes.
const NEGATED_UNCLEAR_PATTERN = /\bnot\s+(that\s+)?(sure|certain|positive)\b/i;

const AFFIRMATIVE_PATTERN =
  /\b(yes|yeah|yea|yep|yup|sure|ok|okay|correct|confirm(ed)?|definitely|absolutely|please\s+do|go\s*ahead|sounds\s+good)\b/i;

/**
 * Classifies a raw message as answering a pending yes/no question.
 * Word-boundary matching only (never a bare substring check), so this never
 * mistakes "Lamborghini Urus" or "insurance" for a plain confirmation.
 */
export function classifyShortReply(message: string): ShortReplyIntentValue {
  const normalized = message.trim();
  if (normalized.length === 0) return ShortReplyIntent.UNCLEAR;
  if (NEGATIVE_PATTERN.test(normalized)) return ShortReplyIntent.NEGATIVE;
  if (NEGATED_UNCLEAR_PATTERN.test(normalized)) return ShortReplyIntent.UNCLEAR;
  if (AFFIRMATIVE_PATTERN.test(normalized)) return ShortReplyIntent.AFFIRMATIVE;
  return ShortReplyIntent.UNCLEAR;
}
