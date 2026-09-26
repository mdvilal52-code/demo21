import { AppError } from '@ai-concierge/domain';
import type { Redis } from 'ioredis';

export interface ChatLimits {
  /** Messages one browser session may send per 10-minute window. */
  perSessionPer10Min: number;
  /** Messages the whole public chat may accept per minute (bounds AI spend and abuse). */
  globalPerMin: number;
}

const SESSION_WINDOW_MS = 10 * 60_000;
const GLOBAL_WINDOW_MS = 60_000;

/**
 * Rate limits for the public web chat. The usual per-IP limiter cannot work
 * here: every chat message reaches the API through the website's server, so
 * they all share a handful of source IPs. Limits are instead per *session*
 * (one customer's browser) and for the chat as a whole, in Redis so they hold
 * across API instances. Fixed windows keyed by the window index: cheap, and a
 * burst at a window edge is still bounded by twice the limit.
 *
 * Fails open if Redis is unreachable — the request is still bounded by the
 * global IP limiter's absence being the lesser evil than taking chat down; the
 * AI provider has its own circuit breaker and rate limit on top.
 */
export async function enforceChatLimits(
  redis: Redis,
  sessionId: string,
  limits: ChatLimits,
  now: number = Date.now(),
): Promise<void> {
  const sessionKey = `chat:rl:s:${sessionId}:${Math.floor(now / SESSION_WINDOW_MS)}`;
  const globalKey = `chat:rl:g:${Math.floor(now / GLOBAL_WINDOW_MS)}`;

  let sessionCount: number;
  let globalCount: number;
  try {
    const results = await redis
      .multi()
      .incr(sessionKey)
      .pexpire(sessionKey, SESSION_WINDOW_MS * 2)
      .incr(globalKey)
      .pexpire(globalKey, GLOBAL_WINDOW_MS * 2)
      .exec();
    sessionCount = Number(results?.[0]?.[1] ?? 0);
    globalCount = Number(results?.[2]?.[1] ?? 0);
  } catch {
    return;
  }

  if (sessionCount > limits.perSessionPer10Min) {
    throw new AppError(
      'RATE_LIMITED',
      'You are sending messages too quickly. Please wait a moment.',
      {
        details: { scope: 'session' },
      },
    );
  }
  if (globalCount > limits.globalPerMin) {
    throw new AppError(
      'RATE_LIMITED',
      'The concierge is very busy right now. Please try again shortly.',
      {
        details: { scope: 'global' },
      },
    );
  }
}
