import { createTestPrismaClient, seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimFailedOutboundMessageForResend,
  createOutboundMessage,
  findOutboundMessageById,
  findOutboundMessagesForConversation,
  findResendableEmailMessages,
  OutboundMessageStatus,
  recordOutboundMessageResendOutcome,
  releaseOutboundMessageResendClaim,
} from './outboundMessageRepository.js';

async function seedConversation(
  prisma: PrismaClient,
  channel: 'EMAIL' | 'WHATSAPP' = 'EMAIL',
  customerRef = 'customer@example.com',
) {
  return prisma.conversation.create({
    data: { tenantId: TEST_TENANT_ID, channel, customerRef },
  });
}

describe('outboundMessageRepository', () => {
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

  it('defaults a created message to SENT — the pre-existing behaviour for every call site that only recorded a delivered reply', async () => {
    const conversation = await seedConversation(prisma);
    const row = await createOutboundMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      content: 'Your quote is ready',
      source: 'AI_GENERATED',
      stage: 'QUOTE_ISSUED',
    });

    expect(row.status).toBe(OutboundMessageStatus.SENT);
    expect(row.deliveryError).toBeNull();
    expect(row.retryCount).toBe(0);
    expect(row.subject).toBeNull();
  });

  it('persists a FAILED send with its error and subject, and it is readable both singly and as part of the conversation', async () => {
    const conversation = await seedConversation(prisma);
    const row = await createOutboundMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      content: 'Your quote is ready',
      source: 'AI_GENERATED',
      stage: 'QUOTE_ISSUED',
      status: OutboundMessageStatus.FAILED,
      deliveryError: 'Mailgun 502',
      subject: 'Re: Urus availability next week',
    });

    expect(row.status).toBe(OutboundMessageStatus.FAILED);
    expect(row.deliveryError).toBe('Mailgun 502');
    expect(row.subject).toBe('Re: Urus availability next week');

    const found = await findOutboundMessageById(prisma, TEST_TENANT_ID, conversation.id, row.id);
    expect(found?.status).toBe(OutboundMessageStatus.FAILED);

    const inThread = await findOutboundMessagesForConversation(prisma, TEST_TENANT_ID, conversation.id);
    expect(inThread.map((m) => m.id)).toEqual([row.id]);
  });

  it('findOutboundMessageById: never returns a message that belongs to a different conversation (regression)', async () => {
    const conversationA = await seedConversation(prisma, 'EMAIL', 'alice@example.com');
    const conversationB = await seedConversation(prisma, 'EMAIL', 'bob@example.com');
    const bobsMessage = await createOutboundMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversationB.id,
      content: "Bob's private quote details",
      source: 'AI_GENERATED',
      stage: 'QUOTE_ISSUED',
      status: OutboundMessageStatus.FAILED,
    });

    // Looking Bob's message up scoped to conversation A (a mismatched pair,
    // as a client could send) must find nothing — never Bob's content.
    const crossConversationLookup = await findOutboundMessageById(
      prisma,
      TEST_TENANT_ID,
      conversationA.id,
      bobsMessage.id,
    );
    expect(crossConversationLookup).toBeNull();

    const correctLookup = await findOutboundMessageById(
      prisma,
      TEST_TENANT_ID,
      conversationB.id,
      bobsMessage.id,
    );
    expect(correctLookup?.id).toBe(bobsMessage.id);
  });

  it('findResendableEmailMessages: only FAILED, EMAIL-channel messages old enough, under the retry cap and not currently claimed, oldest first', async () => {
    const emailConversation = await seedConversation(prisma, 'EMAIL');
    const whatsappConversation = await seedConversation(prisma, 'WHATSAPP');
    const now = Date.now();

    const old = await createOutboundMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: emailConversation.id,
      content: 'oldest failure',
      source: 'AI_GENERATED',
      stage: 'QUOTE_ISSUED',
      status: OutboundMessageStatus.FAILED,
    });
    await prisma.outboundMessage.update({
      where: { id: old.id },
      data: { createdAt: new Date(now - 10 * 60_000) },
    });

    const tooRecent = await createOutboundMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: emailConversation.id,
      content: 'too recent to retry yet',
      source: 'AI_GENERATED',
      stage: 'QUOTE_ISSUED',
      status: OutboundMessageStatus.FAILED,
    });
    await prisma.outboundMessage.update({
      where: { id: tooRecent.id },
      data: { createdAt: new Date(now - 5_000) },
    });

    const exhausted = await createOutboundMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: emailConversation.id,
      content: 'already retried too many times',
      source: 'AI_GENERATED',
      stage: 'QUOTE_ISSUED',
      status: OutboundMessageStatus.FAILED,
    });
    await prisma.outboundMessage.update({
      where: { id: exhausted.id },
      data: { createdAt: new Date(now - 10 * 60_000), retryCount: 5 },
    });

    const currentlyClaimed = await createOutboundMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: emailConversation.id,
      content: 'a staff member is resending this one right now',
      source: 'AI_GENERATED',
      stage: 'QUOTE_ISSUED',
      status: OutboundMessageStatus.FAILED,
    });
    await prisma.outboundMessage.update({
      where: { id: currentlyClaimed.id },
      data: { createdAt: new Date(now - 10 * 60_000), claimedAt: new Date(now - 1_000) },
    });

    await createOutboundMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: emailConversation.id,
      content: 'already sent, not resendable',
      source: 'AI_GENERATED',
      stage: 'QUOTE_ISSUED',
    });

    const whatsappFailure = await createOutboundMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: whatsappConversation.id,
      content: "a whatsapp failure is not this sweep's job",
      source: 'AI_GENERATED',
      stage: 'QUOTE_ISSUED',
      status: OutboundMessageStatus.FAILED,
    });
    await prisma.outboundMessage.update({
      where: { id: whatsappFailure.id },
      data: { createdAt: new Date(now - 10 * 60_000) },
    });

    const due = await findResendableEmailMessages(prisma, {
      retryNotBefore: new Date(now - 60_000),
      maxRetryCount: 5,
      limit: 25,
    });

    expect(due.map((m) => m.id)).toEqual([old.id]);
    expect(due[0]?.customerRef).toBe('customer@example.com');
  });

  it('claimFailedOutboundMessageForResend: only one caller wins, and a stale claim can be reclaimed (regression)', async () => {
    const conversation = await seedConversation(prisma);
    const row = await createOutboundMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      content: 'x',
      source: 'AI_GENERATED',
      stage: 'QUOTE_ISSUED',
      status: OutboundMessageStatus.FAILED,
    });

    const firstClaim = await claimFailedOutboundMessageForResend(prisma, TEST_TENANT_ID, row.id);
    expect(firstClaim).toBe(true);

    // A concurrent second attempt (the sweep racing a staff-triggered
    // resend, or vice versa) must not also win the claim.
    const secondClaim = await claimFailedOutboundMessageForResend(prisma, TEST_TENANT_ID, row.id);
    expect(secondClaim).toBe(false);

    // Releasing it (a crashed attempt, or a NOT_CONFIGURED no-op) makes it claimable again.
    await releaseOutboundMessageResendClaim(prisma, row.id);
    const thirdClaim = await claimFailedOutboundMessageForResend(prisma, TEST_TENANT_ID, row.id);
    expect(thirdClaim).toBe(true);

    // A stale (old) claim is reclaimable even without an explicit release —
    // simulates a worker that crashed mid-attempt.
    await prisma.outboundMessage.update({
      where: { id: row.id },
      data: { claimedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const staleReclaim = await claimFailedOutboundMessageForResend(prisma, TEST_TENANT_ID, row.id);
    expect(staleReclaim).toBe(true);
  });

  it('recordOutboundMessageResendOutcome: SENT clears the error and the claim; FAILED keeps the error, bumps retryCount and releases the claim', async () => {
    const conversation = await seedConversation(prisma);
    const row = await createOutboundMessage(prisma, {
      tenantId: TEST_TENANT_ID,
      conversationId: conversation.id,
      content: 'x',
      source: 'AI_GENERATED',
      stage: 'QUOTE_ISSUED',
      status: OutboundMessageStatus.FAILED,
      deliveryError: 'first failure',
    });
    await claimFailedOutboundMessageForResend(prisma, TEST_TENANT_ID, row.id);

    await recordOutboundMessageResendOutcome(prisma, row.id, {
      status: OutboundMessageStatus.FAILED,
      deliveryError: 'second failure',
    });
    const afterSecondFailure = await findOutboundMessageById(prisma, TEST_TENANT_ID, conversation.id, row.id);
    expect(afterSecondFailure?.status).toBe(OutboundMessageStatus.FAILED);
    expect(afterSecondFailure?.deliveryError).toBe('second failure');
    expect(afterSecondFailure?.retryCount).toBe(1);
    // The claim was released, so a fresh attempt can claim it again.
    expect(await claimFailedOutboundMessageForResend(prisma, TEST_TENANT_ID, row.id)).toBe(true);

    await recordOutboundMessageResendOutcome(prisma, row.id, {
      status: OutboundMessageStatus.SENT,
      deliveryError: null,
    });
    const afterSuccess = await findOutboundMessageById(prisma, TEST_TENANT_ID, conversation.id, row.id);
    expect(afterSuccess?.status).toBe(OutboundMessageStatus.SENT);
    expect(afterSuccess?.deliveryError).toBeNull();
  });
});
