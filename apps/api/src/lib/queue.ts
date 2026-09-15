import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@ai-concierge/contracts';
import type { Redis } from 'ioredis';

export function createPostEnquiryQueue(connection: Redis): Queue {
  return new Queue(QUEUE_NAMES.POST_ENQUIRY_PROCESSING, { connection });
}
