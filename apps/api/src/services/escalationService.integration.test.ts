import {
  createTestPrismaClient,
  seedTestTenants,
  seedTestUser,
  truncateAllTables,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import { findJourneyByConversationId, type PrismaClient } from '@ai-concierge/db';
import { EligibilityDecisionStatus, JourneyState, MissingInfoStatus } from '@ai-concierge/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeNotificationProvider } from '../test/fakeNotificationProvider.js';
import { recordEligibilityOutcome, syncJourneyAfterMissingInfo } from './journeyService.js';
import { assignEscalation, listEscalations, resolveEscalation } from './escalationService.js';

async function seedEscalatedJourney(
  prisma: PrismaClient,
  notificationProvider: FakeNotificationProvider,
) {
  const conversation = await prisma.conversation.create({
    data: { tenantId: TEST_TENANT_ID, channel: 'WHATSAPP', customerRef: '+15550008888' },
  });
  const message = await prisma.message.create({
    data: { conversationId: conversation.id, content: 'test' },
  });
  await syncJourneyAfterMissingInfo(
    { prisma, notificationProvider },
    {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      messageId: message.id,
      resolvedVehicleId: null,
      missingInfoStatus: MissingInfoStatus.COMPLETE,
      requestId: 'req-1',
    },
  );
  await recordEligibilityOutcome(
    { prisma, notificationProvider },
    {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      status: EligibilityDecisionStatus.NEEDS_HUMAN_REVIEW,
      reason: 'high-risk exception',
      requestId: 'req-2',
    },
  );
  return conversation;
}

describe('escalationService', () => {
  let prisma: PrismaClient;
  let notificationProvider: FakeNotificationProvider;

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
    notificationProvider = new FakeNotificationProvider();
  });

  it('lists OPEN escalations for the tenant', async () => {
    await seedEscalatedJourney(prisma, notificationProvider);
    const items = await listEscalations(
      { prisma },
      { tenantId: TEST_TENANT_ID, status: 'OPEN', limit: 20, offset: 0 },
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.reason).toBe('ELIGIBILITY_NEEDS_REVIEW');
  });

  it('assigns an OPEN case to a worker, moving it to IN_PROGRESS', async () => {
    await seedEscalatedJourney(prisma, notificationProvider);
    const worker = await seedTestUser(prisma, { tenantId: TEST_TENANT_ID, role: 'MANAGER' });
    const [openCase] = await listEscalations(
      { prisma },
      { tenantId: TEST_TENANT_ID, status: 'OPEN', limit: 20, offset: 0 },
    );

    const assigned = await assignEscalation(
      { prisma },
      {
        tenantId: TEST_TENANT_ID,
        escalationCaseId: openCase!.id,
        assignedToUserId: worker.id,
        requestId: 'req-3',
      },
    );
    expect(assigned.status).toBe('IN_PROGRESS');
    expect(assigned.assignedToUserId).toBe(worker.id);
  });

  it('resolving APPROVED resumes the journey to exactly the state it was escalated from', async () => {
    const conversation = await seedEscalatedJourney(prisma, notificationProvider);
    const worker = await seedTestUser(prisma, { tenantId: TEST_TENANT_ID, role: 'MANAGER' });
    const [openCase] = await listEscalations(
      { prisma },
      { tenantId: TEST_TENANT_ID, status: 'OPEN', limit: 20, offset: 0 },
    );

    const resolved = await resolveEscalation(
      { prisma },
      {
        tenantId: TEST_TENANT_ID,
        escalationCaseId: openCase!.id,
        resolvedByUserId: worker.id,
        resolution: 'APPROVED',
        resolutionNote: 'confirmed with the customer directly',
        requestId: 'req-3',
      },
    );
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolution).toBe('APPROVED');

    const journey = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
    // The case was escalated FROM ELIGIBILITY_CHECK (see recordEligibilityOutcome), so APPROVED resumes there.
    expect(journey?.state).toBe(JourneyState.ELIGIBILITY_CHECK);
  });

  it('resolving REJECTED moves the journey to DECLINED', async () => {
    const conversation = await seedEscalatedJourney(prisma, notificationProvider);
    const worker = await seedTestUser(prisma, { tenantId: TEST_TENANT_ID, role: 'MANAGER' });
    const [openCase] = await listEscalations(
      { prisma },
      { tenantId: TEST_TENANT_ID, status: 'OPEN', limit: 20, offset: 0 },
    );

    await resolveEscalation(
      { prisma },
      {
        tenantId: TEST_TENANT_ID,
        escalationCaseId: openCase!.id,
        resolvedByUserId: worker.id,
        resolution: 'REJECTED',
        resolutionNote: 'does not meet policy, no override',
        requestId: 'req-3',
      },
    );

    const journey = await findJourneyByConversationId(prisma, TEST_TENANT_ID, conversation.id);
    expect(journey?.state).toBe(JourneyState.DECLINED);
  });

  it('a second resolve attempt on an already-resolved case throws CONFLICT', async () => {
    await seedEscalatedJourney(prisma, notificationProvider);
    const worker = await seedTestUser(prisma, { tenantId: TEST_TENANT_ID, role: 'MANAGER' });
    const [openCase] = await listEscalations(
      { prisma },
      { tenantId: TEST_TENANT_ID, status: 'OPEN', limit: 20, offset: 0 },
    );

    await resolveEscalation(
      { prisma },
      {
        tenantId: TEST_TENANT_ID,
        escalationCaseId: openCase!.id,
        resolvedByUserId: worker.id,
        resolution: 'APPROVED',
        resolutionNote: 'ok',
        requestId: 'req-3',
      },
    );

    await expect(
      resolveEscalation(
        { prisma },
        {
          tenantId: TEST_TENANT_ID,
          escalationCaseId: openCase!.id,
          resolvedByUserId: worker.id,
          resolution: 'REJECTED',
          resolutionNote: 'changed my mind',
          requestId: 'req-4',
        },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('assigning an already-assigned case throws CONFLICT rather than silently reassigning', async () => {
    await seedEscalatedJourney(prisma, notificationProvider);
    const workerA = await seedTestUser(prisma, {
      tenantId: TEST_TENANT_ID,
      role: 'MANAGER',
      email: 'a@example.com',
    });
    const workerB = await seedTestUser(prisma, {
      tenantId: TEST_TENANT_ID,
      role: 'MANAGER',
      email: 'b@example.com',
    });
    const [openCase] = await listEscalations(
      { prisma },
      { tenantId: TEST_TENANT_ID, status: 'OPEN', limit: 20, offset: 0 },
    );

    await assignEscalation(
      { prisma },
      {
        tenantId: TEST_TENANT_ID,
        escalationCaseId: openCase!.id,
        assignedToUserId: workerA.id,
        requestId: 'req-3',
      },
    );

    await expect(
      assignEscalation(
        { prisma },
        {
          tenantId: TEST_TENANT_ID,
          escalationCaseId: openCase!.id,
          assignedToUserId: workerB.id,
          requestId: 'req-4',
        },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
