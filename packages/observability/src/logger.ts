import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Paths pino redacts to `[REDACTED]` before a log line is ever serialized.
 * Covers common places secrets and PII end up in structured logs: request
 * headers/bodies, env dumps, and free-text customer message fields.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.webhookSigningSecret',
  '*.message',
  '*.content',
  '*.rawBody',
];

export interface CreateLoggerOptions {
  level: LoggerOptions['level'];
  serviceName: string;
  pretty?: boolean;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  return pino({
    level: options.level,
    base: { service: options.serviceName },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}
