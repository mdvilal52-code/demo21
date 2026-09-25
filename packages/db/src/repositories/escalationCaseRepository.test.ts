import {
  createInitialJourneyContext,
  EscalationReason,
  EscalationResolution,
  EscalationStatus,
  EscalationTier,
  type TenantId,
} from '@ai-concierge/domain';
import {
  createTestPrismaClient,
  seedTestTenants,
  seedTestUser,
  truncateAllTables,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireJourneyLock, createJourney } from './journeyRepository.js';
import {
  assignEscalationCase,
  createEscalationCase,
  findBreachedEscalationCases,
  findEscalationCaseById,
  findOpenEscalationCaseForJourney,
  listEscalationCases,
  markEscalationCaseSlaBreached,
  resolveEscalationCase,
} from './escalationCaseRepository.js';

async function seedJourney(prisma: PrismaClient, tenantId: TenantId) {
  const conversation = await prisma.conversation.create({
    data: { tenantId, channel: 'WHATSAPP', customerRef: '+15550000002' },
  });
  return prisma.$transaction(async (tx) => {
    await acquireJourneyLock(tx, tenantId, conversation.id);
    return createJourney(tx, {
      tenantId,
      conversationId: conversation.id,
      context: createInitialJourneyContext(conversation.id),
    });
  });
}

describe('escalationCaseRepository', () => {
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

  it('creates a case with an SLA due date derived from the tier', async () => {
    const journey = await seedJourney(prisma, TEST_TENANT_ID);
    const now = new Date('2026-10-01T00:00:00.000Z');

    const created = await prisma.$transaction((tx) =>
      createEscalationCase(
        tx,
        TEST_TENANT_ID,
        {
          journeyId: journey.id,
          tier: EscalationTier.T3,
          reason: EscalationReason.QUOTE_NEEDS_REVIEW,
          detail: 'large discount applied',
        },
        now,
      ),
    );

    expect(created.status).toBe(EscalationStatus.OPEN);
    expect(created.slaBreached).toBe(false);
    expect(new Date(created.slaDueAt).getTime()).toBe(now.getTime() + 240 * 60_000);

    const found = await findEscalationCaseById(prisma, TEST_TENANT_ID, created.id);
    expect(found?.id).toBe(created.id);

    const openForJourney = await findOpenEscalationCaseForJourney(
      prisma,
      TEST_TENANT_ID,
      journey.id,
    );
    expect(openForJourney?.id).toBe(created.id);
  });

  it('assigns an OPEN case to a worker and moves it to IN_PROGRESS', async () => {
    const journey = await seedJourney(prisma, TEST_TENANT_ID);
    const worker = await seedTestUser(prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
    const created = await prisma.$transaction((tx) =>
      createEscalationCase(
        tx,
        TEST_TENANT_ID,
        {
          journeyId: journey.id,
          tier: EscalationTier.T2,
          reason: EscalationReason.MISSING_INFO_STALLED,
          detail: 'no reply after 3 attempts',
        },
        new Date(),
      ),
    );

    const assigned = await assignEscalationCase(prisma, TEST_TENANT_ID, created.id, worker.id);
    expect(assigned?.status).toBe(EscalationStatus.IN_PROGRESS);
    expect(assigned?.assignedToUserId).toBe(worker.id);

    // Assigning an already-assigned case is a no-op failure, not a silent reassignment.
    const otherWorker = await seedTestUser(prisma, {
      tenantId: TEST_TENANT_ID,
      role: 'MANAGER',
      email: 'manager@example.com',
    });
    const reassigned = await assignEscalationCase(
      prisma,
      TEST_TENANT_ID,
      created.id,
      otherWorker.id,
    );
    expect(reassigned).toBeNull();
  });

  it('resolves a case exactly once — a second resolve attempt is a no-op', async () => {
    const journey = await seedJourney(prisma, TEST_TENANT_ID);
    const worker = await seedTestUser(prisma, { tenantId: TEST_TENANT_ID, role: 'MANAGER' });
    const created = await prisma.$transaction((tx) =>
      createEscalationCase(
        tx,
        TEST_TENANT_ID,
        {
          journeyId: journey.id,
          tier: EscalationTier.T3,
          reason: EscalationReason.ELIGIBILITY_NEEDS_REVIEW,
          detail: 'nationality override, high risk',
        },
        new Date(),
      ),
    );

    const resolved = await resolveEscalationCase(prisma, {
      tenantId: TEST_TENANT_ID,
      id: created.id,
      resolvedByUserId: worker.id,
      resolution: EscalationResolution.APPROVED,
      resolutionNote: 'confirmed VIP, waived',
      now: new Date(),
    });
    expect(resolved?.status).toBe(EscalationStatus.RESOLVED);
    expect(resolved?.resolution).toBe(EscalationResolution.APPROVED);

    const secondAttempt = await resolveEscalationCase(prisma, {
      tenantId: TEST_TENANT_ID,
      id: created.id,
      resolvedByUserId: worker.id,
      resolution: EscalationResolution.REJECTED,
      resolutionNote: 'changed my mind',
      now: new Date(),
    });
    expect(secondAttempt).toBeNull();

    const stillApproved = await findEscalationCaseById(prisma, TEST_TENANT_ID, created.id);
    expect(stillApproved?.resolution).toBe(EscalationResolution.APPROVED);
  });

  it('lists cases filtered by status, most-open-first', async () => {
    const journey = await seedJourney(prisma, TEST_TENANT_ID);
    const worker = await seedTestUser(prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
    const openCase = await prisma.$transaction((tx) =>
      createEscalationCase(
        tx,
        TEST_TENANT_ID,
        {
          journeyId: journey.id,
          tier: EscalationTier.T2,
          reason: EscalationReason.MISSING_INFO_STALLED,
          detail: 'x',
        },
        new Date(),
      ),
    );
    const resolvedCase = await prisma.$transaction((tx) =>
      createEscalationCase(
        tx,
        TEST_TENANT_ID,
        {
          journeyId: journey.id,
          tier: EscalationTier.T2,
          reason: EscalationReason.MISSING_INFO_STALLED,
          detail: 'y',
        },
        new Date(),
      ),
    );
    await resolveEscalationCase(prisma, {
      tenantId: TEST_TENANT_ID,
      id: resolvedCase.id,
      resolvedByUserId: worker.id,
      resolution: EscalationResolution.REJECTED,
      resolutionNote: 'declined',
      now: new Date(),
    });

    const openOnly = await listEscalationCases(prisma, {
      tenantId: TEST_TENANT_ID,
      status: 'OPEN',
      limit: 10,
      offset: 0,
    });
    expect(openOnly.map((c) => c.id)).toEqual([openCase.id]);
  });

  it('the SLA sweep finds only breached, still-open cases and marks them exactly once', async () => {
    const journey = await seedJourney(prisma, TEST_TENANT_ID);
    const past = new Date(Date.now() - 10 * 60_000);
    const overdue = await prisma.$transaction((tx) =>
      createEscalationCase(
        tx,
        TEST_TENANT_ID,
        {
          journeyId: journey.id,
          tier: EscalationTier.T4,
          reason: EscalationReason.CUSTOMER_COMPLAINT,
          detail: 'x',
        },
        past,
      ),
    );
    // T4's SLA is 30 minutes; created 10 minutes ago at `past` is not yet due relative to `past`,
    // but IS overdue relative to "now" once we check with a `now` far enough past `past + 30m`.
    const checkAt = new Date(past.getTime() + 31 * 60_000);

    const breached = await findBreachedEscalationCases(prisma, checkAt);
    expect(breached.map((c) => c.id)).toEqual([overdue.id]);

    await markEscalationCaseSlaBreached(prisma, overdue.id);
    const afterMark = await findBreachedEscalationCases(prisma, checkAt);
    expect(afterMark).toHaveLength(0);

    const persisted = await findEscalationCaseById(prisma, TEST_TENANT_ID, overdue.id);
    expect(persisted?.slaBreached).toBe(true);
  });
});
