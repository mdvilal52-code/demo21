import { describe, expect, it } from 'vitest';
import { AppError, isAppError } from './errors.js';

describe('AppError', () => {
  it('maps a code to the correct http status', () => {
    const error = new AppError('NOT_FOUND', 'Conversation not found');
    expect(error.httpStatus).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('serializes to a stable JSON envelope without leaking the cause', () => {
    const dbError = new Error('password authentication failed for user "postgres"');
    const error = new AppError('INTERNAL', 'Something went wrong', { cause: dbError });
    const json = error.toJSON();
    expect(json).toEqual({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
    expect(JSON.stringify(json)).not.toContain('password authentication failed');
  });

  it('includes explicitly provided details', () => {
    const error = new AppError('VALIDATION_FAILED', 'Invalid payload', {
      details: { field: 'message' },
    });
    expect(error.toJSON().error.details).toEqual({ field: 'message' });
  });

  it('is recognized by isAppError, plain errors are not', () => {
    expect(isAppError(new AppError('INTERNAL', 'x'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError('x')).toBe(false);
  });
});
