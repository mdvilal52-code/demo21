import { createTestRedisClient, flushTestRedis } from '@ai-concierge/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisNotificationLimiter } from './notificationLimiter.js';

describe('RedisNotificationLimiter', () => {
  const redis = createTestRedisClient();
  const limits = { perRecipientPerDay: 2, globalSmsPerDay: 4, globalEmailPerDay: 3 };

  beforeEach(async () => {
    await flushTestRedis(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('lets one recipient receive only a few messages a day, per medium', async () => {
    const limiter = new RedisNotificationLimiter(redis, limits);
    expect(await limiter.allow('SMS', '+971501234567')).toBe(true);
    expect(await limiter.allow('SMS', '+971501234567')).toBe(true);
    expect(await limiter.allow('SMS', '+971501234567')).toBe(false);
    // Another medium, and another recipient, are counted separately.
    expect(await limiter.allow('EMAIL', '+971501234567')).toBe(true);
    expect(await limiter.allow('SMS', '+971509999999')).toBe(true);
  });

  it('treats an email address case-insensitively', async () => {
    const limiter = new RedisNotificationLimiter(redis, limits);
    expect(await limiter.allow('EMAIL', 'Sara@Example.com')).toBe(true);
    expect(await limiter.allow('EMAIL', 'sara@example.com')).toBe(true);
    expect(await limiter.allow('EMAIL', 'SARA@EXAMPLE.COM')).toBe(false);
  });

  it('caps the total per medium per day, however many different numbers are used', async () => {
    const limiter = new RedisNotificationLimiter(redis, limits);
    const results: boolean[] = [];
    for (let index = 0; index < 6; index += 1) {
      results.push(await limiter.allow('SMS', `+97150000000${index}`));
    }
    expect(results).toEqual([true, true, true, true, false, false]);
  });

  it('starts fresh the next day', async () => {
    let now = Date.UTC(2026, 9, 1, 10);
    const limiter = new RedisNotificationLimiter(redis, limits, () => now);
    await limiter.allow('SMS', '+971501234567');
    await limiter.allow('SMS', '+971501234567');
    expect(await limiter.allow('SMS', '+971501234567')).toBe(false);
    now += 24 * 60 * 60_000;
    expect(await limiter.allow('SMS', '+971501234567')).toBe(true);
  });

  it('stores no phone number or email in Redis', async () => {
    const limiter = new RedisNotificationLimiter(redis, limits);
    await limiter.allow('SMS', '+971501234567');
    await limiter.allow('EMAIL', 'sara@example.com');
    const keys = await redis.keys('notify:rl:*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(' ')).not.toMatch(/971501234567|sara@example/);
  });

  it('fails closed when Redis cannot be reached', async () => {
    const broken = new Redis({
      port: 1,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    broken.on('error', () => undefined);
    const limiter = new RedisNotificationLimiter(broken, limits);
    expect(await limiter.allow('SMS', '+971501234567')).toBe(false);
    broken.disconnect();
  });
});
