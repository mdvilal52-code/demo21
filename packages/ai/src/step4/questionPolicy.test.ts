import { describe, expect, it } from 'vitest';
import { QuestionPolicy } from './questionPolicy.js';

const NOW = new Date('2026-09-16T10:00:00.000Z');

describe('QuestionPolicy.selectNewQuestions', () => {
  const policy = new QuestionPolicy();

  it('builds a required question for a missing field', () => {
    const { newQuestions } = policy.selectNewQuestions(
      {
        missingFields: ['PICKUP_TIME'],
        unansweredOptionalFields: [],
        askedFieldKeys: [],
        pendingFreeTextField: null,
        language: 'en',
      },
      NOW,
    );
    expect(newQuestions).toEqual([
      {
        field: 'PICKUP_TIME',
        questionId: 'ask.pickupTime.v1',
        text: 'What time would you like the vehicle ready for pickup?',
        language: 'en',
        required: true,
        askedAt: NOW.toISOString(),
      },
    ]);
  });

  it('builds an optional question for an unanswered optional field', () => {
    const { newQuestions } = policy.selectNewQuestions(
      {
        missingFields: [],
        unansweredOptionalFields: ['SPECIAL_REQUESTS'],
        askedFieldKeys: [],
        pendingFreeTextField: null,
        language: 'en',
      },
      NOW,
    );
    expect(newQuestions).toEqual([
      expect.objectContaining({ field: 'SPECIAL_REQUESTS', required: false }),
    ]);
  });

  it('never re-generates a question for a field already in askedFieldKeys', () => {
    const { newQuestions } = policy.selectNewQuestions(
      {
        missingFields: ['PICKUP_TIME'],
        unansweredOptionalFields: [],
        askedFieldKeys: ['PICKUP_TIME'],
        pendingFreeTextField: null,
        language: 'en',
      },
      NOW,
    );
    expect(newQuestions).toEqual([]);
  });

  it('orders required fields before the optional field', () => {
    const { newQuestions } = policy.selectNewQuestions(
      {
        missingFields: ['FLIGHT_NUMBER', 'PICKUP_TIME'],
        unansweredOptionalFields: ['SPECIAL_REQUESTS'],
        askedFieldKeys: [],
        pendingFreeTextField: null,
        language: 'en',
      },
      NOW,
    );
    expect(newQuestions.map((q) => q.field)).toEqual([
      'FLIGHT_NUMBER',
      'PICKUP_TIME',
      'SPECIAL_REQUESTS',
    ]);
    expect(newQuestions.every((q, i) => (i < 2 ? q.required : !q.required))).toBe(true);
  });

  it('renders Arabic text when the language is ar', () => {
    const { newQuestions } = policy.selectNewQuestions(
      {
        missingFields: ['PICKUP_TIME'],
        unansweredOptionalFields: [],
        askedFieldKeys: [],
        pendingFreeTextField: null,
        language: 'ar',
      },
      NOW,
    );
    expect(newQuestions[0]?.language).toBe('ar');
    expect(newQuestions[0]?.text).toBe('في أي وقت تريد أن تكون المركبة جاهزة للاستلام؟');
  });

  it('falls back to English for an unsupported language', () => {
    const { newQuestions } = policy.selectNewQuestions(
      {
        missingFields: ['PICKUP_TIME'],
        unansweredOptionalFields: [],
        askedFieldKeys: [],
        pendingFreeTextField: null,
        language: 'hi',
      },
      NOW,
    );
    expect(newQuestions[0]?.language).toBe('en');
  });

  it('only ever proposes one free-text question at a time, required field first', () => {
    const { newQuestions } = policy.selectNewQuestions(
      {
        missingFields: ['DROPOFF_ADDRESS'],
        unansweredOptionalFields: ['SPECIAL_REQUESTS'],
        askedFieldKeys: [],
        pendingFreeTextField: null,
        language: 'en',
      },
      NOW,
    );
    expect(newQuestions.map((q) => q.field)).toEqual(['DROPOFF_ADDRESS']);
  });

  it('holds back a new optional free-text question while a required one is already pending', () => {
    const { newQuestions, withdrawnFields } = policy.selectNewQuestions(
      {
        missingFields: [],
        unansweredOptionalFields: ['SPECIAL_REQUESTS'],
        askedFieldKeys: ['DROPOFF_ADDRESS'],
        pendingFreeTextField: 'DROPOFF_ADDRESS', // required, already pending from an earlier turn
        language: 'en',
      },
      NOW,
    );
    expect(newQuestions).toEqual([]);
    expect(withdrawnFields).toEqual([]);
  });

  it('bumps an already-pending optional question to make room for a newly-required free-text field', () => {
    // e.g. SPECIAL_REQUESTS was asked first (nothing else was missing yet); a later turn's
    // fresh Step 2 read now makes DROPOFF_ADDRESS required — it must not be blocked forever.
    const { newQuestions, withdrawnFields } = policy.selectNewQuestions(
      {
        missingFields: ['DROPOFF_ADDRESS'],
        unansweredOptionalFields: [],
        askedFieldKeys: ['SPECIAL_REQUESTS'],
        pendingFreeTextField: 'SPECIAL_REQUESTS',
        language: 'en',
      },
      NOW,
    );
    expect(withdrawnFields).toEqual(['SPECIAL_REQUESTS']);
    expect(newQuestions.map((q) => q.field)).toEqual(['DROPOFF_ADDRESS']);
  });
});
