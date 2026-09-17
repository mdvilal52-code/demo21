import { describe, expect, it } from 'vitest';
import { checkMissingInfoParamsSchema, checkMissingInfoResponseSchema } from './missingInfo.js';

describe('checkMissingInfoParamsSchema', () => {
  it('accepts a valid conversation id', () => {
    expect(
      checkMissingInfoParamsSchema.safeParse({
        conversationId: '11111111-1111-1111-1111-111111111111',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-uuid conversation id', () => {
    expect(checkMissingInfoParamsSchema.safeParse({ conversationId: 'nope' }).success).toBe(false);
  });
});

describe('checkMissingInfoResponseSchema', () => {
  const missingInfo = {
    status: 'NEEDS_INFO',
    collected: {
      pickupDate: null,
      returnDate: null,
      pickupLocation: null,
      dropoffLocation: null,
      vehicle: null,
    },
    missingFields: [{ field: 'PICKUP_DATE', reason: 'NOT_PROVIDED' }],
    clarificationPrompt: 'Could you please confirm when you would like to pick up the car?',
    expiresAt: '2026-09-18T00:00:00.000Z',
    flags: { promptInjectionDetectedAnywhere: false },
    modelMetadata: { engine: 'missing-info-evaluator-v1', version: '0.1.0', deterministic: true },
  };

  it('accepts a full response', () => {
    const result = checkMissingInfoResponseSchema.safeParse({
      conversationId: '11111111-1111-1111-1111-111111111111',
      messageId: '22222222-2222-2222-2222-222222222222',
      missingInfo,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a response missing the missingInfo payload', () => {
    const result = checkMissingInfoResponseSchema.safeParse({
      conversationId: '11111111-1111-1111-1111-111111111111',
      messageId: '22222222-2222-2222-2222-222222222222',
    });
    expect(result.success).toBe(false);
  });
});
