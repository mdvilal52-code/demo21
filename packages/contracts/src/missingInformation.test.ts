import { describe, expect, it } from 'vitest';
import {
  collectMissingInformationParamsSchema,
  collectMissingInformationResponseSchema,
} from './missingInformation.js';

describe('collectMissingInformationParamsSchema', () => {
  it('accepts a valid conversation id', () => {
    expect(
      collectMissingInformationParamsSchema.safeParse({
        conversationId: '11111111-1111-1111-1111-111111111111',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-uuid conversation id', () => {
    expect(
      collectMissingInformationParamsSchema.safeParse({ conversationId: 'not-a-uuid' }).success,
    ).toBe(false);
  });
});

describe('collectMissingInformationResponseSchema', () => {
  const result = {
    status: 'COMPLETE',
    missingFields: [],
    pendingQuestions: [],
    answers: [],
    corrections: [],
    contradictions: [],
    flags: { promptInjectionDetected: false, piiDetected: false },
    modelMetadata: {
      engine: 'missing-information-engine-v1',
      version: '0.1.0',
      deterministic: true,
    },
  };

  it('accepts a complete response', () => {
    const response = collectMissingInformationResponseSchema.safeParse({
      conversationId: '11111111-1111-1111-1111-111111111111',
      messageId: '33333333-3333-3333-3333-333333333333',
      result,
    });
    expect(response.success).toBe(true);
  });

  it('rejects a response missing the result', () => {
    const response = collectMissingInformationResponseSchema.safeParse({
      conversationId: '11111111-1111-1111-1111-111111111111',
      messageId: '33333333-3333-3333-3333-333333333333',
    });
    expect(response.success).toBe(false);
  });
});
