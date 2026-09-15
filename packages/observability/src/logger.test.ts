import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino, type Logger } from 'pino';
import { REDACTED_PATHS } from './logger.js';

function captureLog(logFn: (logger: Logger) => void): unknown {
  let captured = '';
  const stream = new Writable({
    write(chunk, _enc, callback) {
      captured += chunk.toString();
      callback();
    },
  });
  const logger = pino({ redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' } }, stream);
  logFn(logger);
  return JSON.parse(captured);
}

describe('logger redaction', () => {
  it('redacts the authorization header', () => {
    const line = captureLog((logger) =>
      logger.info({ req: { headers: { authorization: 'Bearer secret-token' } } }, 'request'),
    ) as { req: { headers: { authorization: string } } };
    expect(line.req.headers.authorization).toBe('[REDACTED]');
  });

  it('redacts a nested secret field', () => {
    const line = captureLog((logger) =>
      logger.info({ config: { secret: 'top-secret-value' } }, 'boot'),
    ) as { config: { secret: string } };
    expect(line.config.secret).toBe('[REDACTED]');
  });

  it('redacts customer message content', () => {
    const line = captureLog((logger) =>
      logger.info({ message: { content: 'my email is a@b.com' } }, 'enquiry'),
    ) as { message: { content: string } };
    expect(line.message.content).toBe('[REDACTED]');
  });

  it('does not redact unrelated fields', () => {
    const line = captureLog((logger) => logger.info({ requestId: 'abc-123' }, 'ok')) as {
      requestId: string;
    };
    expect(line.requestId).toBe('abc-123');
  });
});
