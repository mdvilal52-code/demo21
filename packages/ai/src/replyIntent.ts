/**
 * Deterministic classifier for a short conversational reply (e.g. "Yes",
 * "No thanks", "Sure") — distinct from `classifyIntentType` in
 * `intent-engine.ts`, which classifies what a message is *about* (booking,
 * pricing, support, ...). This classifies whether a message *answers* a
 * yes/no question, which a booking-shaped keyword lexicon has no concept
 * of: "Yes" carries no booking keyword on its own, and joining it into an
 * accumulated transcript that also has no booking keyword anywhere doesn't
 * create one either. Used by `enquiryService.ts`'s `continueEnquiry` to
 * recognize a bare confirmation reply for what it is, using the
 * conversation's own context (nothing booking-shaped has been recognized
 * yet) instead of re-deriving meaning from isolated keywords.
 */
export const ShortReplyIntent = {
  AFFIRMATIVE: 'AFFIRMATIVE',
  NEGATIVE: 'NEGATIVE',
  UNCLEAR: 'UNCLEAR',
} as const;

export type ShortReplyIntentValue = (typeof ShortReplyIntent)[keyof typeof ShortReplyIntent];

// Checked first: unambiguous negative words, independent of "not".
const HARD_NEGATIVE_PATTERN = /\b(no|nope|nah|never\s*mind|cancel)\b/i;

// Checked next: "not sure"/"not certain"/"not positive" negate what would
// otherwise match AFFIRMATIVE_PATTERN below ("sure") but aren't a firm no
// either — genuinely ambiguous ("I don't know"), not a plain yes or no.
const NEGATED_UNCLEAR_PATTERN = /\bnot\s+(that\s+)?(sure|certain|positive)\b/i;

// Checked before AFFIRMATIVE_PATTERN, not just for "not now"/"not
// interested": a bare "not" negates *any* word that would otherwise read as
// affirmative ("not correct", "definitely not", "absolutely not", "not
// confirmed") — AFFIRMATIVE_PATTERN's own words are meaningless without
// checking for a preceding/following negation first.
const GENERAL_NEGATION_PATTERN = /\bnot\b/i;

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
  if (HARD_NEGATIVE_PATTERN.test(normalized)) return ShortReplyIntent.NEGATIVE;
  if (NEGATED_UNCLEAR_PATTERN.test(normalized)) return ShortReplyIntent.UNCLEAR;
  if (GENERAL_NEGATION_PATTERN.test(normalized)) return ShortReplyIntent.NEGATIVE;
  if (AFFIRMATIVE_PATTERN.test(normalized)) return ShortReplyIntent.AFFIRMATIVE;
  return ShortReplyIntent.UNCLEAR;
}
