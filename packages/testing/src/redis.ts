import { Redis } from 'ioredis';

export function requireTestRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL must be set to run integration tests');
  }
  return url;
}

export function createTestRedisClient(): Redis {
  return new Redis(requireTestRedisUrl(), { maxRetriesPerRequest: null });
}

export async function flushTestRedis(redis: Redis): Promise<void> {
  await redis.flushdb();
}
