import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino, type Logger } from 'pino';
import { checkRedisEvictionPolicy, type RedisConfigReader } from './redisHealth.js';

function captureLogs(run: (logger: Logger) => Promise<void>): Promise<unknown[]> {
  const lines: unknown[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      lines.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  const logger = pino(stream);
  return run(logger).then(() => lines);
}

describe('checkRedisEvictionPolicy', () => {
  it('warns when the policy is not noeviction', async () => {
    const redis: RedisConfigReader = {
      config: async () => ['maxmemory-policy', 'allkeys-lru'],
    };
    const lines = (await captureLogs((logger) =>
      checkRedisEvictionPolicy(redis, logger),
    )) as Array<{
      level: number;
      maxMemoryPolicy?: string;
    }>;
    expect(lines).toHaveLength(1);
    const [warning] = lines;
    expect(warning?.level).toBe(40); // warn
    expect(warning?.maxMemoryPolicy).toBe('allkeys-lru');
  });

  it('does not log when the policy is already noeviction', async () => {
    const redis: RedisConfigReader = {
      config: async () => ['maxmemory-policy', 'noeviction'],
    };
    const lines = await captureLogs((logger) => checkRedisEvictionPolicy(redis, logger));
    expect(lines).toHaveLength(0);
  });

  it('never throws when the CONFIG command is disabled by the provider', async () => {
    const redis: RedisConfigReader = {
      config: async () => {
        throw new Error('ERR unknown command CONFIG');
      },
    };
    const lines = await captureLogs((logger) => checkRedisEvictionPolicy(redis, logger));
    expect(lines.some((line) => (line as { level: number }).level === 40)).toBe(false);
  });

  it('does not warn on an unexpected reply shape', async () => {
    const redis: RedisConfigReader = { config: async () => null };
    const lines = await captureLogs((logger) => checkRedisEvictionPolicy(redis, logger));
    expect(lines.some((line) => (line as { level: number }).level === 40)).toBe(false);
  });
});
