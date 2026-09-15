import { createConversationWithMessage, findConversationById } from '@ai-concierge/db';
import { postEnquiryJobSchema, QUEUE_NAMES } from '@ai-concierge/contracts';
import {
  createTestPrismaClient,
  createTestRedisClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import { Queue, QueueEvents, Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processPostEnquiryJob } from './processors/postEnquiryProcessor.js';

const TEST_QUEUE_NAME = `${QUEUE_NAMES.POST_ENQUIRY_PROCESSING}-worker-integration`;
const noopLogger = { warn() {}, info() {}, error() {} } as never;

describe('worker — integration', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let queue: Queue;
  let queueEvents: QueueEvents;
  let worker: Worker;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    redis = createTestRedisClient();
    queue = new Queue(TEST_QUEUE_NAME, { connection: redis.duplicate() });
    queueEvents = new QueueEvents(TEST_QUEUE_NAME, { connection: redis.duplicate() });
    worker = new Worker(
      TEST_QUEUE_NAME,
      async (job) => {
        const data = postEnquiryJobSchema.parse(job.data);
        await processPostEnquiryJob({ prisma, logger: noopLogger }, data);
      },
      { connection: redis.duplicate() },
    );
    await Promise.all([worker.waitUntilReady(), queueEvents.waitUntilReady()]);
  });

  afterAll(async () => {
    await worker.close();
    await queueEvents.close();
    await queue.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedTestTenants(prisma);
  });

  it('processes a queued job end to end: marks processed and writes an audit event', async () => {
    const { conversation, message } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: 'worker-test-1',
      content: 'I need a car',
    });

    const job = await queue.add('process', {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      messageId: message.id,
      requestId: 'req-worker-1',
    });

    await job.waitUntilFinished(queueEvents, 10_000);

    const processed = await findConversationById(prisma, TEST_TENANT_ID, conversation.id);
    expect(processed?.processedAt).not.toBeNull();

    const auditRows = await prisma.auditEvent.findMany({
      where: { entityId: conversation.id, action: 'conversation.processed' },
    });
    expect(auditRows).toHaveLength(1);
  }, 15_000);

  it('is idempotent when the same conversation is processed twice', async () => {
    const { conversation, message } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: 'worker-test-2',
      content: 'I need a car',
    });

    const jobData = {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      messageId: message.id,
      requestId: 'req-worker-2',
    };

    const firstJob = await queue.add('process', jobData);
    await firstJob.waitUntilFinished(queueEvents, 10_000);
    const secondJob = await queue.add('process', { ...jobData, requestId: 'req-worker-2-retry' });
    await secondJob.waitUntilFinished(queueEvents, 10_000);

    const auditRows = await prisma.auditEvent.findMany({
      where: { entityId: conversation.id, action: 'conversation.processed' },
    });
    expect(auditRows).toHaveLength(1);
  }, 15_000);
});
