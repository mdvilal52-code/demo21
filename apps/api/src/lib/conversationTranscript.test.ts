import { describe, expect, it } from 'vitest';
import { buildAccumulatedTranscript } from './conversationTranscript.js';

describe('buildAccumulatedTranscript', () => {
  it('returns the single message unchanged for a one-message conversation', () => {
    expect(buildAccumulatedTranscript([{ content: 'I want a car' }])).toBe('I want a car');
  });

  it('returns an empty string for no messages', () => {
    expect(buildAccumulatedTranscript([])).toBe('');
  });

  it('joins multiple messages in order, oldest first', () => {
    const transcript = buildAccumulatedTranscript([
      { content: 'I want a Lamborghini Urus' },
      { content: '15 to 19 Oct' },
      { content: 'pickup at Dubai Marina' },
    ]);
    expect(transcript).toBe('I want a Lamborghini Urus\n15 to 19 Oct\npickup at Dubai Marina');
  });

  it('keeps only the most recent 25 messages', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ content: `message ${i}` }));
    const transcript = buildAccumulatedTranscript(messages);
    expect(transcript).not.toContain('message 4\n');
    expect(transcript.startsWith('message 5')).toBe(true);
    expect(transcript.endsWith('message 29')).toBe(true);
  });

  it('truncates from the front once the joined text exceeds the character cap, keeping the most recent text', () => {
    const messages = [{ content: 'a'.repeat(5000) }, { content: 'b'.repeat(5000) }];
    const transcript = buildAccumulatedTranscript(messages);
    expect(transcript.length).toBe(8000);
    expect(transcript.endsWith('b'.repeat(5000))).toBe(true);
    expect(transcript).not.toBe(`${'a'.repeat(5000)}\n${'b'.repeat(5000)}`);
  });
});
