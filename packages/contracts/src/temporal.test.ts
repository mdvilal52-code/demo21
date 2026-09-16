import { describe, expect, it } from 'vitest';
import {
  extractDatesLocationParamsSchema,
  extractDatesLocationResponseSchema,
} from './temporal.js';

describe('extractDatesLocationParamsSchema', () => {
  it('accepts a valid uuid', () => {
    expect(
      extractDatesLocationParamsSchema.safeParse({
        conversationId: '00000000-0000-0000-0000-000000000001',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-uuid', () => {
    expect(
      extractDatesLocationParamsSchema.safeParse({ conversationId: 'not-a-uuid' }).success,
    ).toBe(false);
  });
});

describe('extractDatesLocationResponseSchema', () => {
  const base = {
    conversationId: '00000000-0000-0000-0000-000000000001',
    messageId: '00000000-0000-0000-0000-000000000002',
    extraction: {
      pickupDate: null,
      returnDate: null,
      timezone: null,
      pickupLocation: null,
      dropoffLocation: null,
      locationType: null,
      confidence: 0,
      ambiguities: [],
      validationErrors: [],
      flags: { promptInjectionDetected: false },
      modelMetadata: { engine: 'x', version: '1', deterministic: true },
    },
  };

  it('accepts a minimal, all-null extraction', () => {
    expect(extractDatesLocationResponseSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a missing extraction field', () => {
    const { extraction: _omit, ...rest } = base;
    expect(extractDatesLocationResponseSchema.safeParse(rest).success).toBe(false);
  });
});
