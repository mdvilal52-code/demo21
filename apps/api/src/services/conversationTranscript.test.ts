import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findMessagesForConversation: vi.fn() }));

vi.mock('@ai-concierge/db', () => ({
  findMessagesForConversation: mocks.findMessagesForConversation,
}));

const { buildConversationTranscript } = await import('./conversationTranscript.js');

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

describe('buildConversationTranscript', () => {
  it('joins message contents in order, oldest first', async () => {
    mocks.findMessagesForConversation.mockResolvedValue([
      { id: 'm1', content: 'I want a Urus next month' },
      { id: 'm2', content: 'actually, make it 5 days' },
    ]);

    const transcript = await buildConversationTranscript(
      {} as never,
      TENANT_ID,
      'conv-1',
    );

    expect(transcript).toBe('I want a Urus next month\nactually, make it 5 days');
  });

  it('returns an empty string for a conversation with no messages', async () => {
    mocks.findMessagesForConversation.mockResolvedValue([]);
    const transcript = await buildConversationTranscript({} as never, TENANT_ID, 'conv-1');
    expect(transcript).toBe('');
  });
});
