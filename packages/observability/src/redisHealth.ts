import type { Logger } from 'pino';

// Structural subset of ioredis's client — avoids a dependency just for this type.
export interface RedisConfigReader {
  config(subcommand: 'GET', parameter: string): Promise<unknown>;
}

// Duplicates BullMQ's own eviction-policy check (which only `console.warn`s,
// bypassing structured logging) so a misconfigured policy — silent job loss
// under memory pressure — shows up the same way every other log line does.
export async function checkRedisEvictionPolicy(
  redis: RedisConfigReader,
  logger: Logger,
): Promise<void> {
  let reply: unknown;
  try {
    reply = await redis.config('GET', 'maxmemory-policy');
  } catch (error) {
    logger.debug(
      { err: error },
      'could not read Redis maxmemory-policy (the CONFIG command may be disabled by the provider)',
    );
    return;
  }

  const policy: unknown = Array.isArray(reply) ? (reply as unknown[])[1] : undefined;
  if (typeof policy !== 'string' || policy.length === 0) {
    logger.debug({ reply }, 'unexpected reply reading Redis maxmemory-policy');
    return;
  }

  if (policy !== 'noeviction') {
    logger.warn(
      { maxMemoryPolicy: policy },
      'Redis maxmemory-policy is not "noeviction" — queued jobs (and any other keys on this ' +
        'instance) can be silently evicted under memory pressure; set maxmemory-policy=noeviction ' +
        'on the Redis instance backing REDIS_URL',
    );
  }
}
