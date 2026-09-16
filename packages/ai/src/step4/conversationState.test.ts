import { describe, expect, it } from 'vitest';
import { ConversationState } from './conversationState.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-09-16T10:00:00.000Z');
const LATER = new Date('2026-09-16T10:05:00.000Z');

describe('ConversationState.applyCandidates', () => {
  it('adds a brand-new answer', () => {
    const state = ConversationState.createInitial(TENANT_ID, CONVERSATION_ID);
    const { next, corrections, contradictions } = state.applyCandidates(
      [{ field: 'FLIGHT_NUMBER', value: 'EK203' }],
      'CUSTOMER_REPLY',
      NOW,
    );

    expect(next.data.answers).toEqual([
      {
        field: 'FLIGHT_NUMBER',
        value: 'EK203',
        source: 'CUSTOMER_REPLY',
        answeredAt: NOW.toISOString(),
        corrected: false,
      },
    ]);
    expect(corrections).toEqual([]);
    expect(contradictions).toEqual([]);
  });

  it('is a no-op for a repeated answer with the same value', () => {
    const state = ConversationState.createInitial(TENANT_ID, CONVERSATION_ID);
    const { next: afterFirst } = state.applyCandidates(
      [{ field: 'FLIGHT_NUMBER', value: 'EK203' }],
      'CUSTOMER_REPLY',
      NOW,
    );
    const {
      next: afterSecond,
      corrections,
      contradictions,
    } = afterFirst.applyCandidates(
      [{ field: 'FLIGHT_NUMBER', value: 'EK203' }],
      'CUSTOMER_REPLY',
      LATER,
    );

    expect(afterSecond.data.answers).toHaveLength(1);
    expect(afterSecond.data.answers[0]?.answeredAt).toBe(NOW.toISOString()); // untouched, not "re-asked"
    expect(corrections).toEqual([]);
    expect(contradictions).toEqual([]);
  });

  it('records a correction when a later message states a different value for the same field', () => {
    const state = ConversationState.createInitial(TENANT_ID, CONVERSATION_ID);
    const { next: afterFirst } = state.applyCandidates(
      [{ field: 'DRIVER_REQUIREMENT', value: false }],
      'CUSTOMER_REPLY',
      NOW,
    );
    const { next: afterSecond, corrections } = afterFirst.applyCandidates(
      [{ field: 'DRIVER_REQUIREMENT', value: true }],
      'CUSTOMER_REPLY',
      LATER,
    );

    expect(afterSecond.data.answers).toEqual([
      {
        field: 'DRIVER_REQUIREMENT',
        value: true,
        source: 'CUSTOMER_REPLY',
        answeredAt: LATER.toISOString(),
        corrected: true,
      },
    ]);
    expect(corrections).toEqual([
      {
        field: 'DRIVER_REQUIREMENT',
        previousValue: false,
        newValue: true,
        detectedAt: LATER.toISOString(),
      },
    ]);
  });

  it('records a contradiction (not a correction) when one message states two different values', () => {
    const state = ConversationState.createInitial(TENANT_ID, CONVERSATION_ID);
    const { next, corrections, contradictions } = state.applyCandidates(
      [
        { field: 'DRIVER_REQUIREMENT', value: false },
        { field: 'DRIVER_REQUIREMENT', value: true },
      ],
      'CUSTOMER_REPLY',
      NOW,
    );

    expect(next.data.answers).toEqual([]); // left unset — never guessed
    expect(corrections).toEqual([]);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]).toMatchObject({ field: 'DRIVER_REQUIREMENT' });
    expect(contradictions[0]?.candidates.sort()).toEqual([false, true]);
  });

  it('accumulates corrections/contradictions history in state across turns', () => {
    let state = ConversationState.createInitial(TENANT_ID, CONVERSATION_ID);
    state = state.applyCandidates(
      [{ field: 'FLIGHT_NUMBER', value: 'EK203' }],
      'CUSTOMER_REPLY',
      NOW,
    ).next;
    state = state.applyCandidates(
      [{ field: 'FLIGHT_NUMBER', value: 'EK205' }],
      'CUSTOMER_REPLY',
      LATER,
    ).next;

    expect(state.data.corrections).toHaveLength(1);
  });
});

describe('ConversationState.seedFromStep1', () => {
  it('seeds an answer sourced from Step 1', () => {
    const state = ConversationState.createInitial(TENANT_ID, CONVERSATION_ID).seedFromStep1(
      'DRIVER_REQUIREMENT',
      true,
      NOW,
    );
    expect(state.data.answers).toEqual([
      {
        field: 'DRIVER_REQUIREMENT',
        value: true,
        source: 'STEP1_INTENT',
        answeredAt: NOW.toISOString(),
        corrected: false,
      },
    ]);
  });

  it('never overwrites an existing answer for the same field', () => {
    const state = ConversationState.createInitial(TENANT_ID, CONVERSATION_ID)
      .seedFromStep1('DRIVER_REQUIREMENT', true, NOW)
      .seedFromStep1('DRIVER_REQUIREMENT', false, LATER);
    expect(state.data.answers).toHaveLength(1);
    expect(state.data.answers[0]?.value).toBe(true);
  });
});

describe('ConversationState pending questions', () => {
  it('adds new questions and marks their fields as asked', () => {
    const question = {
      field: 'PICKUP_TIME' as const,
      questionId: 'ask.pickupTime.v1',
      text: 'What time?',
      language: 'en' as const,
      required: true,
      askedAt: NOW.toISOString(),
    };
    const state = ConversationState.createInitial(TENANT_ID, CONVERSATION_ID).addPendingQuestions([
      question,
    ]);
    expect(state.data.pendingQuestions).toEqual([question]);
    expect(state.data.askedFieldKeys).toEqual(['PICKUP_TIME']);
  });

  it('drops a pending question once its field has an answer', () => {
    const question = {
      field: 'PICKUP_TIME' as const,
      questionId: 'ask.pickupTime.v1',
      text: 'What time?',
      language: 'en' as const,
      required: true,
      askedAt: NOW.toISOString(),
    };
    const state = ConversationState.createInitial(TENANT_ID, CONVERSATION_ID)
      .addPendingQuestions([question])
      .applyCandidates([{ field: 'PICKUP_TIME', value: '15:00' }], 'CUSTOMER_REPLY', LATER)
      .next.dropAnsweredQuestions();

    expect(state.data.pendingQuestions).toEqual([]);
    expect(state.data.askedFieldKeys).toEqual(['PICKUP_TIME']); // still remembered as "asked"
  });
});

describe('ConversationState bookkeeping', () => {
  it('increments the turn count', () => {
    const state = ConversationState.createInitial(TENANT_ID, CONVERSATION_ID).incrementTurn();
    expect(state.data.turnCount).toBe(1);
  });

  it('merges flags without clearing a previously-set one', () => {
    const state = ConversationState.createInitial(TENANT_ID, CONVERSATION_ID)
      .withFlags({ promptInjectionDetected: true, piiDetected: false })
      .withFlags({ promptInjectionDetected: false, piiDetected: true });
    expect(state.data.flags).toEqual({ promptInjectionDetected: true, piiDetected: true });
  });
});
