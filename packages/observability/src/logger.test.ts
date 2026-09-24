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

  it('redacts a whole nested message object, not just its content property', () => {
    // The bare top-level `message` path (see the test below) also matches
    // one level deep, and redacts the *entire* value at that key — a
    // strictly safer superset of redacting only its `.content` child.
    const line = captureLog((logger) =>
      logger.info({ wrapper: { message: { content: 'my email is a@b.com' } } }, 'enquiry'),
    ) as { wrapper: { message: string } };
    expect(line.wrapper.message).toBe('[REDACTED]');
  });

  it('redacts a top-level message field (the common flat logger.info({ ... }) call shape)', () => {
    const line = captureLog((logger) =>
      logger.info({ requestId: 'req-1', message: 'raw customer text +971501234567' }, 'decision'),
    ) as { message: string; requestId: string };
    expect(line.message).toBe('[REDACTED]');
    expect(line.requestId).toBe('req-1');
  });

  it('redacts a top-level secret-shaped field', () => {
    const line = captureLog((logger) =>
      logger.info({ webhookSigningSecret: 'super-secret-value' }, 'boot'),
    ) as { webhookSigningSecret: string };
    expect(line.webhookSigningSecret).toBe('[REDACTED]');
  });

  it('redacts a top-level rawBody/content field', () => {
    const line = captureLog((logger) =>
      logger.info({ rawBody: 'raw', content: 'also raw' }, 'inbound'),
    ) as { rawBody: string; content: string };
    expect(line.rawBody).toBe('[REDACTED]');
    expect(line.content).toBe('[REDACTED]');
  });

  it('does not redact unrelated fields', () => {
    const line = captureLog((logger) => logger.info({ requestId: 'abc-123' }, 'ok')) as {
      requestId: string;
    };
    expect(line.requestId).toBe('abc-123');
  });
});
