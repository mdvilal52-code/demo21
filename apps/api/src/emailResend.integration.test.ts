import { createHmac } from 'node:crypto';
import { createVehicle } from '@ai-concierge/db';
import { seedTestTenants, seedTestUser, truncateAllTables, TEST_TENANT_ID, TEST_USER_PASSWORD } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import { FakeEmailProvider } from './test/fakeEmailProvider.js';

/**
 * Email retry/resend, end to end: a Mailgun send that fails is persisted
 * (not dropped) so it can be resent later — automatically by the worker's
 * sweep (unit-tested separately, `apps/worker/src/jobs/emailResendSweep.test.ts`)
 * or, here, by a staff member from the dashboard.
 */
const SIGNING_KEY = 'test-mailgun-signing-key-resend-0123456789';

function mailgunPayload(overrides: Record<string, string> = {}): URLSearchParams {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = overrides.token ?? `token-${Math.random().toString(36).slice(2)}`;
  const signature = createHmac('sha256', SIGNING_KEY).update(`${timestamp}${token}`).digest('hex');
  const fields: Record<string, string> = {
    sender: 'customer@example.com',
    recipient: 'concierge@fleet.example.com',
    subject: 'Booking enquiry',
    'body-plain': 'I want to rent a Lamborghini Urus 15-19 Oct, Dubai',
    'Message-Id': `<${token}@mail.example.com>`,
    timestamp,
    token,
    signature,
    ...overrides,
  };
  return new URLSearchParams(fields);
}

describe('email resend — integration', () => {
  let testApp: TestApp;
  let fakeProvider: FakeEmailProvider;

  beforeAll(async () => {
    fakeProvider = new FakeEmailProvider();
    testApp = await buildTestApp(
      { MAILGUN_WEBHOOK_SIGNING_KEY: SIGNING_KEY },
      { emailProvider: fakeProvider },
    );
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
    fakeProvider.sent.length = 0;
    fakeProvider.failNextCount = 0;
    await createVehicle(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      make: 'Lamborghini',
      model: 'Urus',
      color: 'Black',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
  });

  async function sendInbound(overrides: Record<string, string> = {}) {
    const body = mailgunPayload(overrides);
    return testApp.app.inject({
      method: 'POST',
      url: '/webhooks/email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: body.toString(),
    });
  }

  async function staffToken() {
    await seedTestUser(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      role: 'ADMIN',
      email: 'admin@example.com',
    });
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@example.com', password: TEST_USER_PASSWORD },
    });
    return response.json().accessToken as string;
  }

  it('persists a failed automatic reply instead of dropping it, and a staff member can resend it', async () => {
    fakeProvider.failNextCount = 1;
    const ack = await sendInbound();
    expect(ack.statusCode).toBe(200);
    expect(fakeProvider.sent).toHaveLength(0); // the send genuinely failed, nothing went out

    const conversation = await testApp.ctx.prisma.conversation.findFirst({
      where: { customerRef: 'customer@example.com' },
    });
    expect(conversation).not.toBeNull();

    const failedMessage = await testApp.ctx.prisma.outboundMessage.findFirst({
      where: { conversationId: conversation!.id },
    });
    expect(failedMessage?.status).toBe('FAILED');
    expect(failedMessage?.deliveryError).toBeTruthy();
    expect(failedMessage?.content).toBeTruthy();

    const token = await staffToken();
    const resend = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversation!.id}/outbound-messages/${failedMessage!.id}/resend`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toEqual({ delivered: true, status: 'SENT' });
    expect(fakeProvider.sent).toHaveLength(1);
    expect(fakeProvider.sent[0]?.to).toBe('customer@example.com');
    expect(fakeProvider.sent[0]?.body).toBe(failedMessage!.content);
    // The customer's own email thread's subject is preserved, not a generic fallback.
    expect(fakeProvider.sent[0]?.subject).toBe(failedMessage!.subject);
    expect(fakeProvider.sent[0]?.subject).toMatch(/^Re: Booking enquiry/);

    const updated = await testApp.ctx.prisma.outboundMessage.findUnique({
      where: { id: failedMessage!.id },
    });
    expect(updated?.status).toBe('SENT');
    expect(updated?.deliveryError).toBeNull();
  });

  it('never resends a different conversation\'s message even if the ids are passed mismatched (regression)', async () => {
    // Alice's conversation.
    fakeProvider.failNextCount = 1;
    await sendInbound({ sender: 'alice@example.com', token: 'alice-token' });
    const aliceConversation = await testApp.ctx.prisma.conversation.findFirstOrThrow({
      where: { customerRef: 'alice@example.com' },
    });

    // Bob's conversation, with its own FAILED (private) message.
    fakeProvider.failNextCount = 1;
    await sendInbound({ sender: 'bob@example.com', token: 'bob-token' });
    const bobConversation = await testApp.ctx.prisma.conversation.findFirstOrThrow({
      where: { customerRef: 'bob@example.com' },
    });
    const bobsMessage = await testApp.ctx.prisma.outboundMessage.findFirstOrThrow({
      where: { conversationId: bobConversation.id },
    });

    const token = await staffToken();
    // Alice's conversationId paired with Bob's outboundMessageId.
    const crossConversationResend = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${aliceConversation.id}/outbound-messages/${bobsMessage.id}/resend`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(crossConversationResend.statusCode).toBe(404);
    expect(fakeProvider.sent).toHaveLength(0); // nothing was sent to Alice with Bob's content

    const bobsMessageAfter = await testApp.ctx.prisma.outboundMessage.findUniqueOrThrow({
      where: { id: bobsMessage.id },
    });
    expect(bobsMessageAfter.status).toBe('FAILED'); // untouched — Bob still needs a real resend
  });

  it('never sends a message twice when two resend requests race on the same FAILED message', async () => {
    fakeProvider.failNextCount = 1;
    await sendInbound();
    const conversation = await testApp.ctx.prisma.conversation.findFirstOrThrow({
      where: { customerRef: 'customer@example.com' },
    });
    const failedMessage = await testApp.ctx.prisma.outboundMessage.findFirstOrThrow({
      where: { conversationId: conversation.id },
    });
    const token = await staffToken();

    const resendUrl = `/v1/enquiries/${conversation.id}/outbound-messages/${failedMessage.id}/resend`;
    const [first, second] = await Promise.all([
      testApp.app.inject({ method: 'POST', url: resendUrl, headers: { authorization: `Bearer ${token}` } }),
      testApp.app.inject({ method: 'POST', url: resendUrl, headers: { authorization: `Bearer ${token}` } }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]); // one wins the claim, the other is told to try again shortly
    expect(fakeProvider.sent).toHaveLength(1); // the customer receives it exactly once
  });

  it('rejects resending a message that already delivered', async () => {
    await sendInbound(); // succeeds — fakeProvider.failNextCount is 0
    const conversation = await testApp.ctx.prisma.conversation.findFirst({
      where: { customerRef: 'customer@example.com' },
    });
    const sentMessage = await testApp.ctx.prisma.outboundMessage.findFirst({
      where: { conversationId: conversation!.id },
    });
    expect(sentMessage?.status).toBe('SENT');

    const token = await staffToken();
    const resend = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversation!.id}/outbound-messages/${sentMessage!.id}/resend`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(resend.statusCode).toBe(409);
  });

  it('a failed staff reply is also persisted as FAILED, attributed to the staff member, and resendable', async () => {
    await sendInbound(); // establishes the conversation
    const conversation = await testApp.ctx.prisma.conversation.findFirst({
      where: { customerRef: 'customer@example.com' },
    });
    const token = await staffToken();
    const staffUser = await testApp.ctx.prisma.user.findFirstOrThrow({
      where: { email: 'admin@example.com' },
    });

    fakeProvider.failNextCount = 1;
    const reply = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversation!.id}/staff-reply`,
      headers: { authorization: `Bearer ${token}` },
      payload: { message: 'Checking with the team and back to you shortly.' },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().delivered).toBe(false);

    const failedStaffMessage = await testApp.ctx.prisma.outboundMessage.findFirst({
      where: { conversationId: conversation!.id, source: 'HUMAN' },
    });
    expect(failedStaffMessage?.status).toBe('FAILED');
    expect(failedStaffMessage?.authorUserId).toBe(staffUser.id);
    expect(failedStaffMessage?.content).toBe('Checking with the team and back to you shortly.');

    const resend = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversation!.id}/outbound-messages/${failedStaffMessage!.id}/resend`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toEqual({ delivered: true, status: 'SENT' });
  });
});
