import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  markConversationProcessed: vi.fn(),
  auditRecord: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  markConversationProcessed: mocks.markConversationProcessed,
  PrismaAuditWriter: class {
    record = mocks.auditRecord;
  },
}));

const { processPostEnquiryJob } = await import('./postEnquiryProcessor.js');

const job = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  conversationId: 'conv-1',
  messageId: 'msg-1',
  requestId: 'req-1',
};

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
}

describe('processPostEnquiryJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks the conversation processed and writes an audit event', async () => {
    mocks.markConversationProcessed.mockResolvedValue({ count: 1 });
    const logger = makeLogger();

    await processPostEnquiryJob({ prisma: {} as never, logger }, job);

    expect(mocks.markConversationProcessed).toHaveBeenCalledWith(
      {},
      job.tenantId,
      job.conversationId,
    );
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conversation.processed', entityId: job.conversationId }),
    );
  });

  it('is a no-op (idempotent) when nothing matched, without writing a duplicate audit event', async () => {
    mocks.markConversationProcessed.mockResolvedValue({ count: 0 });
    const logger = makeLogger();

    await processPostEnquiryJob({ prisma: {} as never, logger }, job);

    expect(mocks.auditRecord).not.toHaveBeenCalled();
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });
});
