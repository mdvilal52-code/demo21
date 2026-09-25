/**
 * Bounds on how much conversation history gets joined into one extraction
 * input — never trust customer input, including its volume: without a cap,
 * a customer sending many messages before a conversation resolves would
 * grow Steps 1-3's extraction input unboundedly.
 */
const MAX_TRANSCRIPT_MESSAGES = 25;
const MAX_TRANSCRIPT_LENGTH = 8000;

/**
 * Joins a conversation's messages (oldest first) into one transcript so
 * Steps 1-3's existing deterministic engines can resolve a field mentioned
 * in an earlier turn even when the latest message alone doesn't repeat it —
 * e.g. "I want a Lamborghini Urus" in turn 1 plus "15 to 19 Oct" in turn 2
 * still resolves both the vehicle and the dates. Bounded to the most recent
 * messages/characters; for a single-message conversation this returns that
 * message's content unchanged.
 */
export function buildAccumulatedTranscript(messages: Array<{ content: string }>): string {
  const recent = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  const joined = recent.map((message) => message.content).join('\n');
  return joined.length > MAX_TRANSCRIPT_LENGTH
    ? joined.slice(joined.length - MAX_TRANSCRIPT_LENGTH)
    : joined;
}
