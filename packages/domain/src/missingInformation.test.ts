import { describe, expect, it } from 'vitest';
import {
  conversationStateSchema,
  missingInfoAnswerSchema,
  missingInformationResultSchema,
  pendingQuestionSchema,
} from './missingInformation.js';

const now = '2026-09-16T10:00:00.000Z';

describe('missingInfoAnswerSchema', () => {
  it('accepts a well-formed flight number answer', () => {
    const result = missingInfoAnswerSchema.safeParse({
      field: 'FLIGHT_NUMBER',
      value: 'EK203',
      source: 'CUSTOMER_REPLY',
      answeredAt: now,
      corrected: false,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a boolean value for DRIVER_REQUIREMENT', () => {
    const result = missingInfoAnswerSchema.safeParse({
      field: 'DRIVER_REQUIREMENT',
      value: true,
      source: 'STEP1_INTENT',
      answeredAt: now,
      corrected: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a string value for DRIVER_REQUIREMENT (typed per field)', () => {
    const result = missingInfoAnswerSchema.safeParse({
      field: 'DRIVER_REQUIREMENT',
      value: 'yes',
      source: 'STEP1_INTENT',
      answeredAt: now,
      corrected: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a boolean value for FLIGHT_NUMBER (typed per field)', () => {
    const result = missingInfoAnswerSchema.safeParse({
      field: 'FLIGHT_NUMBER',
      value: true,
      source: 'CUSTOMER_REPLY',
      answeredAt: now,
      corrected: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a PICKUP_TIME value that is not 24h HH:MM', () => {
    const result = missingInfoAnswerSchema.safeParse({
      field: 'PICKUP_TIME',
      value: '3pm',
      source: 'CUSTOMER_REPLY',
      answeredAt: now,
      corrected: false,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a canonical 24h PICKUP_TIME value', () => {
    const result = missingInfoAnswerSchema.safeParse({
      field: 'PICKUP_TIME',
      value: '15:00',
      source: 'CUSTOMER_REPLY',
      answeredAt: now,
      corrected: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown field literal', () => {
    const result = missingInfoAnswerSchema.safeParse({
      field: 'PASSPORT_NUMBER',
      value: 'A1234567',
      source: 'CUSTOMER_REPLY',
      answeredAt: now,
      corrected: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('pendingQuestionSchema', () => {
  it('accepts a well-formed question', () => {
    const result = pendingQuestionSchema.safeParse({
      field: 'PICKUP_TIME',
      questionId: 'ask.pickupTime.v1',
      text: 'What time would you like the vehicle ready for pickup?',
      language: 'en',
      required: true,
      askedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty question id', () => {
    const result = pendingQuestionSchema.safeParse({
      field: 'PICKUP_TIME',
      questionId: '',
      text: 'x',
      language: 'en',
      required: true,
      askedAt: now,
    });
    expect(result.success).toBe(false);
  });
});

describe('missingInformationResultSchema', () => {
  const base = {
    status: 'COMPLETE',
    missingFields: [],
    pendingQuestions: [],
    answers: [],
    corrections: [],
    contradictions: [],
    flags: { promptInjectionDetected: false, piiDetected: false },
    modelMetadata: { engine: 'missing-info-v1', version: '0.1.0', deterministic: true },
  };

  it('accepts a complete result with no missing fields', () => {
    expect(missingInformationResultSchema.safeParse(base).success).toBe(true);
  });

  it('accepts an awaiting-customer result with a pending question', () => {
    const result = missingInformationResultSchema.safeParse({
      ...base,
      status: 'AWAITING_CUSTOMER',
      missingFields: ['PICKUP_TIME'],
      pendingQuestions: [
        {
          field: 'PICKUP_TIME',
          questionId: 'ask.pickupTime.v1',
          text: 'What time would you like the vehicle ready for pickup?',
          language: 'en',
          required: true,
          askedAt: now,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a correction record with mismatched previous/new value types', () => {
    const result = missingInformationResultSchema.safeParse({
      ...base,
      corrections: [
        {
          field: 'DRIVER_REQUIREMENT',
          previousValue: false,
          newValue: true,
          detectedAt: now,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a contradiction with fewer than 2 candidates', () => {
    const result = missingInformationResultSchema.safeParse({
      ...base,
      contradictions: [
        { field: 'FLIGHT_NUMBER', candidates: ['EK203'], message: 'x', detectedAt: now },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a status outside the enum', () => {
    const result = missingInformationResultSchema.safeParse({ ...base, status: 'IN_PROGRESS' });
    expect(result.success).toBe(false);
  });
});

describe('conversationStateSchema', () => {
  it('accepts a fresh, empty state', () => {
    const result = conversationStateSchema.safeParse({
      tenantId: '00000000-0000-0000-0000-000000000001',
      conversationId: '11111111-1111-1111-1111-111111111111',
      status: 'AWAITING_CUSTOMER',
      answers: [],
      askedFieldKeys: [],
      pendingQuestions: [],
      corrections: [],
      contradictions: [],
      flags: { promptInjectionDetected: false, piiDetected: false },
      turnCount: 0,
      version: 0,
      lastProcessedMessageId: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a state that has processed at least one message', () => {
    const result = conversationStateSchema.safeParse({
      tenantId: '00000000-0000-0000-0000-000000000001',
      conversationId: '11111111-1111-1111-1111-111111111111',
      status: 'COMPLETE',
      answers: [],
      askedFieldKeys: [],
      pendingQuestions: [],
      corrections: [],
      contradictions: [],
      flags: { promptInjectionDetected: false, piiDetected: false },
      turnCount: 1,
      version: 0,
      lastProcessedMessageId: '33333333-3333-3333-3333-333333333333',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a negative turn count', () => {
    const result = conversationStateSchema.safeParse({
      tenantId: '00000000-0000-0000-0000-000000000001',
      conversationId: '11111111-1111-1111-1111-111111111111',
      status: 'AWAITING_CUSTOMER',
      answers: [],
      askedFieldKeys: [],
      pendingQuestions: [],
      corrections: [],
      contradictions: [],
      flags: { promptInjectionDetected: false, piiDetected: false },
      turnCount: -1,
      version: 0,
      lastProcessedMessageId: null,
    });
    expect(result.success).toBe(false);
  });
});
