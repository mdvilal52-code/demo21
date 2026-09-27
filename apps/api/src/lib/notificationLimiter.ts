import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

export type NotificationMedium = 'EMAIL' | 'SMS';

export interface NotificationLimits {
  /** Messages one recipient (phone or email) may receive per day, per medium. */
  perRecipientPerDay: number;
  /** All customer SMS the system may send per day (bounds Twilio spend). */
  globalSmsPerDay: number;
  /** All customer emails the system may send per day. */
  globalEmailPerDay: number;
}

export interface NotificationLimiter {
  /** True when one more message to this recipient may go out (and counts it). */
  allow(medium: NotificationMedium, recipient: string): Promise<boolean>;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The customer types the phone number or email we notify, so anyone can make
 * the concierge text or email a stranger — or run up the SMS bill with
 * throw-away chat sessions. Three caps stop that: per recipient per day, and
 * a global daily ceiling per medium. Counted in Redis (shared across API
 * instances); recipients are hashed so no phone number or email is stored
 * there. If Redis cannot be reached the answer is "no": failing closed costs
 * one missed notification, failing open costs an open SMS tap.
 */
export class RedisNotificationLimiter implements NotificationLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly limits: NotificationLimits,
    private readonly now: () => number = Date.now,
  ) {}

  async allow(medium: NotificationMedium, recipient: string): Promise<boolean> {
    const day = Math.floor(this.now() / DAY_MS);
    const digest = createHash('sha256').update(recipient.toLowerCase()).digest('hex').slice(0, 32);
    const recipientKey = `notify:rl:${medium}:to:${digest}:${day}`;
    const globalKey = `notify:rl:${medium}:all:${day}`;
    const globalLimit =
      medium === 'SMS' ? this.limits.globalSmsPerDay : this.limits.globalEmailPerDay;
    try {
      const results = await this.redis
        .multi()
        .incr(recipientKey)
        .pexpire(recipientKey, DAY_MS * 2)
        .incr(globalKey)
        .pexpire(globalKey, DAY_MS * 2)
        .exec();
      const recipientCount = Number(results?.[0]?.[1] ?? Number.MAX_SAFE_INTEGER);
      const globalCount = Number(results?.[2]?.[1] ?? Number.MAX_SAFE_INTEGER);
      return recipientCount <= this.limits.perRecipientPerDay && globalCount <= globalLimit;
    } catch {
      return false;
    }
  }
}
