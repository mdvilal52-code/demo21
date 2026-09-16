import {
  seedTestTenants,
  truncateAllTables,
  TEST_TENANT_ID,
  OTHER_TENANT_ID,
} from '@ai-concierge/testing';
import { MAX_MISSING_INFO_TURNS } from '@ai-concierge/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

describe('POST /v1/enquiries/:conversationId/missing-information — integration', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
  });

  async function createConversation(
    message: string,
    channel: 'WHATSAPP' | 'WEB' | 'EMAIL' = 'WHATSAPP',
  ) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries',
      payload: { channel, customerRef: `${channel.toLowerCase()}-session-1`, message },
    });
    expect(response.statusCode).toBe(201);
    return response.json().conversationId as string;
  }

  async function extractDatesLocation(conversationId: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/dates-location`,
    });
    expect(response.statusCode).toBe(201);
  }

  async function determineVehicle(conversationId: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/vehicle-selection`,
    });
    expect(response.statusCode).toBe(201);
  }

  /** Runs Steps 1-3 (the dependency chain Step 4 requires) end to end. */
  async function runSteps123(message: string, channel: 'WHATSAPP' | 'WEB' | 'EMAIL' = 'WHATSAPP') {
    const conversationId = await createConversation(message, channel);
    await extractDatesLocation(conversationId);
    await determineVehicle(conversationId);
    return conversationId;
  }

  async function reply(conversationId: string, message: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/messages`,
      payload: { message },
    });
    expect(response.statusCode).toBe(201);
  }

  async function collectMissingInfo(conversationId: string) {
    return testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${conversationId}/missing-information`,
    });
  }

  it('recognizes a complete request end to end when every required field is already stated', async () => {
    const conversationId = await runSteps123(
      'I want to rent a car from Atlantis The Palm to Burj Al Arab on 15 Oct, I need a driver, ready at 3pm',
    );

    const response = await collectMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);
    const { result } = response.json();
    expect(result.status).toBe('COMPLETE');
    expect(result.missingFields).toEqual([]);
  });

  it('reports exactly one missing field when only pickup time is unknown', async () => {
    const conversationId = await runSteps123(
      'I want to rent a car from Atlantis The Palm to Burj Al Arab on 15 Oct, I need a driver',
    );

    const response = await collectMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);
    const { result } = response.json();
    expect(result.status).toBe('AWAITING_CUSTOMER');
    expect(result.missingFields).toEqual(['PICKUP_TIME']);
  });

  it('reports every genuinely missing required field for an airport pickup on the Web channel', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport', 'WEB');

    const response = await collectMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);
    const { result } = response.json();
    expect([...result.missingFields].sort()).toEqual(
      [
        'CONTACT_DETAILS',
        'DRIVER_REQUIREMENT',
        'DROPOFF_ADDRESS',
        'FLIGHT_NUMBER',
        'PICKUP_TIME',
      ].sort(),
    );
  });

  it('persists the state and an audit event for each turn', async () => {
    const conversationId = await runSteps123('I need a car', 'WEB');
    await collectMissingInfo(conversationId);

    const stateCount = await testApp.ctx.prisma.missingInformationState.count();
    expect(stateCount).toBe(1);

    const auditRows = await testApp.ctx.prisma.auditEvent.findMany({
      where: { action: 'missing_information.evaluated' },
    });
    expect(auditRows).toHaveLength(1);
  });

  it('treats a retried call against the same unchanged message as a no-op replay', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport', 'WEB');

    const first = await collectMissingInfo(conversationId);
    const second = await collectMissingInfo(conversationId);

    // Same computed result both times — nothing new to report.
    expect(second.json().result).toEqual(first.json().result);

    const state = await testApp.ctx.prisma.missingInformationState.findFirst({
      where: { conversationId },
    });
    expect(state?.turnCount).toBe(1); // the retry never counted as a second turn

    const auditRows = await testApp.ctx.prisma.auditEvent.findMany({
      where: { action: 'missing_information.evaluated' },
    });
    expect(auditRows).toHaveLength(1); // no duplicate audit event for the replay
  });

  it('does not let replayed retries burn through the abuse-protection turn cap', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport', 'WEB');
    await collectMissingInfo(conversationId);
    await testApp.ctx.prisma.missingInformationState.updateMany({
      where: { tenantId: TEST_TENANT_ID, conversationId },
      data: { turnCount: MAX_MISSING_INFO_TURNS },
    });

    // A retry against the same (still unanswered) latest message must still succeed as a replay.
    const response = await collectMissingInfo(conversationId);
    expect(response.statusCode).toBe(201);
  });

  it('completes over multiple turns as the customer replies to each outstanding question', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport', 'WEB');

    const turn1 = await collectMissingInfo(conversationId);
    expect(turn1.json().result.status).toBe('AWAITING_CUSTOMER');

    await reply(
      conversationId,
      'My flight is EK203, I need a driver, contact me at jane@example.com',
    );
    const turn2 = await collectMissingInfo(conversationId);
    const turn2Fields = turn2.json().result.missingFields as string[];
    expect(turn2Fields).not.toContain('FLIGHT_NUMBER');
    expect(turn2Fields).not.toContain('DRIVER_REQUIREMENT');
    expect(turn2Fields).not.toContain('CONTACT_DETAILS');
    expect(turn2Fields).toEqual(expect.arrayContaining(['PICKUP_TIME', 'DROPOFF_ADDRESS']));

    await reply(conversationId, 'Pickup at 3pm, drop off at Burj Al Arab');
    const turn3 = await collectMissingInfo(conversationId);
    expect(turn3.json().result.status).toBe('COMPLETE');
    expect(turn3.json().result.missingFields).toEqual([]);
  });

  it('treats a repeated answer across turns as a no-op, not a new correction', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport', 'WEB');
    await collectMissingInfo(conversationId);

    await reply(conversationId, 'My flight is EK203');
    const turn2 = await collectMissingInfo(conversationId);
    expect(turn2.json().result.corrections).toEqual([]);

    await reply(conversationId, 'Just confirming, flight EK203');
    const turn3 = await collectMissingInfo(conversationId);
    expect(turn3.json().result.corrections).toEqual([]);
    expect(
      turn3.json().result.answers.find((a: { field: string }) => a.field === 'FLIGHT_NUMBER')
        ?.value,
    ).toBe('EK203');
  });

  it('detects a correction when a later reply states a different value for an already-known field', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport', 'WEB');
    await collectMissingInfo(conversationId);
    await reply(conversationId, 'My flight is EK203');
    await collectMissingInfo(conversationId);

    await reply(conversationId, 'Correction: my flight is actually EK205');
    const turn3 = await collectMissingInfo(conversationId);
    expect(turn3.json().result.corrections).toEqual([
      expect.objectContaining({
        field: 'FLIGHT_NUMBER',
        previousValue: 'EK203',
        newValue: 'EK205',
      }),
    ]);
  });

  it('flags a same-message contradiction and leaves the field unset', async () => {
    const conversationId = await runSteps123('I need a car', 'WEB');
    await collectMissingInfo(conversationId);

    await reply(conversationId, 'self-drive please, actually no I need a driver');
    const turn2 = await collectMissingInfo(conversationId);
    const { result } = turn2.json();
    expect(result.contradictions).toEqual([
      expect.objectContaining({ field: 'DRIVER_REQUIREMENT' }),
    ]);
    expect(result.missingFields).toContain('DRIVER_REQUIREMENT');
  });

  it('returns 409 when Step 1-3 have not completed yet for this conversation', async () => {
    const conversationId = await createConversation('I need a car');
    const response = await collectMissingInfo(conversationId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
    expect(response.json().error.details.missingSteps).toEqual(
      expect.arrayContaining(['dates/location (Step 2)', 'vehicle (Step 3)']),
    );
  });

  it('returns 409 when only Step 3 has not completed yet', async () => {
    const conversationId = await createConversation('I need a car');
    await extractDatesLocation(conversationId);
    const response = await collectMissingInfo(conversationId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details.missingSteps).toEqual(['vehicle (Step 3)']);
  });

  it('never lets a Step 4 turn for one conversation leak into another conversation (session isolation)', async () => {
    const conversationA = await runSteps123('I need a car, pickup from DXB airport', 'WEB');
    const conversationB = await runSteps123('I need a car, pickup from DXB airport', 'WEB');

    await collectMissingInfo(conversationA);
    await reply(conversationA, 'My flight is EK203');
    await collectMissingInfo(conversationA);

    const responseB = await collectMissingInfo(conversationB);
    const answersB = responseB.json().result.answers as Array<{ field: string }>;
    expect(answersB.some((a) => a.field === 'FLIGHT_NUMBER')).toBe(false);
  });

  it('rejects a conversation belonging to another tenant scope (defense in depth)', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport', 'WEB');
    await testApp.ctx.prisma.conversation.update({
      where: { id: conversationId },
      data: { tenantId: OTHER_TENANT_ID },
    });

    const response = await collectMissingInfo(conversationId);
    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for an unknown conversation', async () => {
    const response = await collectMissingInfo('00000000-0000-0000-0000-000000009999');
    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for a malformed conversation id', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/enquiries/not-a-uuid/missing-information',
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 429 once a conversation reaches the abuse-protection turn cap on a genuine new turn', async () => {
    const conversationId = await runSteps123('I need a car, pickup from DXB airport', 'WEB');
    await collectMissingInfo(conversationId);
    await testApp.ctx.prisma.missingInformationState.updateMany({
      where: { tenantId: TEST_TENANT_ID, conversationId },
      data: { turnCount: MAX_MISSING_INFO_TURNS },
    });

    // A new reply makes the next call a genuine turn, not a replay of the same message.
    await reply(conversationId, 'My flight is EK203');
    const response = await collectMissingInfo(conversationId);
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('RATE_LIMITED');
  });
});
