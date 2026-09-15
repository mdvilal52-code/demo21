import {
  createTestPrismaClient,
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConversationWithMessage, findConversationById } from './conversationRepository.js';

describe('SQL injection resistance (Prisma parameterization)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedTestTenants(prisma);
  });

  it('stores a SQL injection payload as inert literal text instead of executing it', async () => {
    const payload = "'; DROP TABLE conversations; --";
    const { conversation, message } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: payload,
      content: `I want to rent a car ${payload}`,
    });

    expect(message.content).toContain(payload);
    expect(conversation.customerRef).toBe(payload);

    // if the payload had executed, this table would no longer exist
    const stillExists = await findConversationById(prisma, TEST_TENANT_ID, conversation.id);
    expect(stillExists).not.toBeNull();
  });

  it('a UNION-based payload in customerRef never leaks rows from another table', async () => {
    const payload = "' UNION SELECT id, name, name, now() FROM tenants; --";
    const { conversation } = await createConversationWithMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      channel: 'WEB',
      customerRef: payload,
      content: 'hello',
    });
    const found = await findConversationById(prisma, TEST_TENANT_ID, conversation.id);
    expect(found?.customerRef).toBe(payload);
  });
});
