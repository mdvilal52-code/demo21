import { describe, expect, it } from 'vitest';
import {
  postConversationReplyParamsSchema,
  postConversationReplyRequestSchema,
  postConversationReplyResponseSchema,
} from './conversationReply.js';

describe('postConversationReplyParamsSchema', () => {
  it('accepts a valid conversation id', () => {
    expect(
      postConversationReplyParamsSchema.safeParse({
        conversationId: '11111111-1111-1111-1111-111111111111',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-uuid conversation id', () => {
    expect(
      postConversationReplyParamsSchema.safeParse({ conversationId: 'not-a-uuid' }).success,
    ).toBe(false);
  });
});

describe('postConversationReplyRequestSchema', () => {
  it('accepts a non-empty message', () => {
    expect(
      postConversationReplyRequestSchema.safeParse({ message: 'my flight is EK203' }).success,
    ).toBe(true);
  });

  it('rejects an empty message', () => {
    expect(postConversationReplyRequestSchema.safeParse({ message: '' }).success).toBe(false);
  });

  it('rejects a message over the shared length limit', () => {
    expect(
      postConversationReplyRequestSchema.safeParse({ message: 'a'.repeat(4001) }).success,
    ).toBe(false);
  });
});

describe('postConversationReplyResponseSchema', () => {
  it('accepts a well-formed response', () => {
    const result = postConversationReplyResponseSchema.safeParse({
      conversationId: '11111111-1111-1111-1111-111111111111',
      messageId: '33333333-3333-3333-3333-333333333333',
    });
    expect(result.success).toBe(true);
  });
});
