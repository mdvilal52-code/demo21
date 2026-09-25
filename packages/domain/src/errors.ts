/**
 * Stable, enumerable error codes. Never leak internals (stack traces, driver
 * error messages, SQL) to a client — only this code, a safe message, and an
 * optional `details` object built explicitly by the caller.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** An AI provider responded, but its output was empty, safety-blocked, malformed, or failed grounding/schema validation — never trusted past this point. */
  AI_RESPONSE_INVALID: 'AI_RESPONSE_INVALID',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  PAYLOAD_TOO_LARGE: 413,
  UPSTREAM_UNAVAILABLE: 502,
  NOT_CONFIGURED: 501,
  AI_RESPONSE_INVALID: 502,
  INTERNAL: 500,
};

export interface AppErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * The only error type application code should throw. Route error handlers
 * translate this into a stable JSON envelope; anything else becomes a
 * generic 500 with no internal detail exposed.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
    this.details = options.details;
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
