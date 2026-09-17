import type { MissingField } from '@ai-concierge/domain';
import { describe, expect, it } from 'vitest';
import { buildClarificationPrompt } from './clarificationPromptBuilder.js';

describe('buildClarificationPrompt', () => {
  it('returns null when nothing is missing', () => {
    expect(buildClarificationPrompt([])).toBeNull();
  });

  it('builds a single-field question without a detail', () => {
    const fields: MissingField[] = [{ field: 'PICKUP_DATE', reason: 'NOT_PROVIDED' }];
    expect(buildClarificationPrompt(fields)).toBe(
      'Could you please confirm when you would like to pick up the car?',
    );
  });

  it('includes the detail when one is present', () => {
    const fields: MissingField[] = [
      { field: 'PICKUP_DATE', reason: 'AMBIGUOUS', detail: '"10/11/26" could mean either date' },
    ];
    expect(buildClarificationPrompt(fields)).toBe(
      'Could you please confirm your exact pickup date ("10/11/26" could mean either date)?',
    );
  });

  it('joins two fields with "and", no comma', () => {
    const fields: MissingField[] = [
      { field: 'PICKUP_DATE', reason: 'NOT_PROVIDED' },
      { field: 'VEHICLE', reason: 'NOT_PROVIDED' },
    ];
    expect(buildClarificationPrompt(fields)).toBe(
      'Could you please confirm when you would like to pick up the car and which vehicle you would like to rent?',
    );
  });

  it('joins three or more fields with an Oxford comma', () => {
    const fields: MissingField[] = [
      { field: 'PICKUP_DATE', reason: 'NOT_PROVIDED' },
      { field: 'RETURN_DATE', reason: 'NOT_PROVIDED' },
      { field: 'PICKUP_LOCATION', reason: 'NOT_PROVIDED' },
    ];
    expect(buildClarificationPrompt(fields)).toBe(
      'Could you please confirm when you would like to pick up the car, when you would like to return the car, and where you would like to pick up the car?',
    );
  });

  it('produces a distinct, reason-appropriate phrase for an INVALID vehicle', () => {
    const fields: MissingField[] = [
      {
        field: 'VEHICLE',
        reason: 'INVALID',
        detail: 'Bentley Continental is not currently offered',
      },
    ];
    expect(buildClarificationPrompt(fields)).toBe(
      'Could you please confirm which vehicle you would like (Bentley Continental is not currently offered)?',
    );
  });
});
