import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Field names redacted to `[REDACTED]` before a log line is ever
 * serialized, both as a top-level key (`logger.info({ message: rawText })`
 * — the overwhelmingly common call shape in this codebase) and nested one
 * level under another key (`logger.info({ req: { headers: {
 * authorization } } })`). fast-redact (which pino uses) resolves `*.foo` as
 * "any key's `.foo` property" — it does *not* also match a bare top-level
 * `foo`, so listing only the `*.`-prefixed form would silently pass a
 * flat `{ message: '...' }` call straight through unredacted. Both forms
 * are listed for every field for that reason; see `logger.test.ts`'s
 * top-level cases.
 */
const SENSITIVE_FIELD_NAMES = [
  'password',
  'token',
  'secret',
  'apiKey',
  'webhookSigningSecret',
  'message',
  'content',
  'rawBody',
];

export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  ...SENSITIVE_FIELD_NAMES,
  ...SENSITIVE_FIELD_NAMES.map((field) => `*.${field}`),
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
