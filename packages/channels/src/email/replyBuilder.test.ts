import { describe, expect, it } from 'vitest';
import { MissingInfoStatus, type MissingInfoResult } from '@ai-concierge/domain';
import { buildEmailReplySubject } from './replyBuilder.js';

function fakeResult(status: MissingInfoResult['status']): MissingInfoResult {
  return {
    status,
    collected: {
      vehicle: null,
      pickupDate: null,
      returnDate: null,
      pickupLocation: null,
      dropoffLocation: null,
    },
    missingFields: [],
    clarificationPrompt: null,
    expiresAt: new Date().toISOString(),
    flags: { promptInjectionDetectedAnywhere: false },
    modelMetadata: { engine: 'test', version: '1.0.0', deterministic: true },
  };
}

describe('buildEmailReplySubject', () => {
  it('returns a distinct, deterministic subject for every MissingInfoStatus value', () => {
    const subjects = new Set<string>();
    for (const status of Object.values(MissingInfoStatus)) {
      const subject = buildEmailReplySubject(fakeResult(status));
      expect(subject.length).toBeGreaterThan(0);
      subjects.add(subject);
    }
    expect(subjects.size).toBe(Object.values(MissingInfoStatus).length);
  });
});
