import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimFailedOutboundMessageForResend: vi.fn(),
  findResendableEmailMessages: vi.fn(),
  recordOutboundMessageResendOutcome: vi.fn(),
  releaseOutboundMessageResendClaim: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  claimFailedOutboundMessageForResend: mocks.claimFailedOutboundMessageForResend,
  findResendableEmailMessages: mocks.findResendableEmailMessages,
  recordOutboundMessageResendOutcome: mocks.recordOutboundMessageResendOutcome,
  releaseOutboundMessageResendClaim: mocks.releaseOutboundMessageResendClaim,
}));

const { startEmailResendSweep } = await import('./emailResendSweep.js');

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() } as never;
}

function makeMessage(
  overrides: Partial<{ id: string; tenantId: string; customerRef: string; content: string; subject: string | null }> = {},
) {
  return {
    id: 'om-1',
    tenantId: 'tenant-1',
    content: 'Your quote is ready',
    subject: 'Re: Urus availability',
    source: 'AI_GENERATED',
    stage: 'QUOTE_ISSUED',
    authorUserId: null,
    status: 'FAILED',
    deliveryError: 'timeout',
    retryCount: 0,
    createdAt: new Date('2026-09-27T00:00:00.000Z'),
    customerRef: 'customer@example.com',
    ...overrides,
  };
}

describe('startEmailResendSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.claimFailedOutboundMessageForResend.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims each due message before resending it, using its own stored subject, and records SENT on success', async () => {
    const message = makeMessage();
    mocks.findResendableEmailMessages.mockResolvedValue([message]);
    const emailProvider = { name: 'fake', sendEmail: vi.fn().mockResolvedValue({ status: 'SENT' }) };
    const logger = makeLogger();

    const stop = startEmailResendSweep({
      prisma: {} as never,
      emailProvider: emailProvider as never,
      logger,
      intervalMs: 1000,
      minAgeMs: 60_000,
      maxAttempts: 5,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.claimFailedOutboundMessageForResend).toHaveBeenCalledWith({}, 'tenant-1', 'om-1');
    expect(emailProvider.sendEmail).toHaveBeenCalledWith(
      'customer@example.com',
      'Re: Urus availability',
      'Your quote is ready',
    );
    expect(mocks.recordOutboundMessageResendOutcome).toHaveBeenCalledWith({}, 'om-1', {
      status: 'SENT',
      deliveryError: null,
    });
    expect((logger as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
      { attempted: 1, resent: 1 },
      expect.any(String),
    );

    stop();
  });

  it('falls back to the default subject when the stored one is null (a row from before the subject column existed)', async () => {
    mocks.findResendableEmailMessages.mockResolvedValue([makeMessage({ subject: null })]);
    const emailProvider = { name: 'fake', sendEmail: vi.fn().mockResolvedValue({ status: 'SENT' }) };

    const stop = startEmailResendSweep({
      prisma: {} as never,
      emailProvider: emailProvider as never,
      logger: makeLogger(),
      intervalMs: 1000,
      minAgeMs: 60_000,
      maxAttempts: 5,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(emailProvider.sendEmail).toHaveBeenCalledWith(
      'customer@example.com',
      expect.stringContaining('Re:'),
      'Your quote is ready',
    );

    stop();
  });

  it('skips a message another resend already claimed (the race the claim exists to prevent)', async () => {
    mocks.findResendableEmailMessages.mockResolvedValue([makeMessage()]);
    mocks.claimFailedOutboundMessageForResend.mockResolvedValue(false);
    const emailProvider = { name: 'fake', sendEmail: vi.fn() };
    const logger = makeLogger();

    const stop = startEmailResendSweep({
      prisma: {} as never,
      emailProvider: emailProvider as never,
      logger,
      intervalMs: 1000,
      minAgeMs: 60_000,
      maxAttempts: 5,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(emailProvider.sendEmail).not.toHaveBeenCalled();
    expect(mocks.recordOutboundMessageResendOutcome).not.toHaveBeenCalled();
    expect((logger as { info: ReturnType<typeof vi.fn> }).info).not.toHaveBeenCalled();

    stop();
  });

  it('records a further FAILED outcome (bumping retryCount) without treating it as resent', async () => {
    mocks.findResendableEmailMessages.mockResolvedValue([makeMessage()]);
    const emailProvider = {
      name: 'fake',
      sendEmail: vi.fn().mockResolvedValue({ status: 'FAILED', error: 'still down' }),
    };
    const logger = makeLogger();

    const stop = startEmailResendSweep({
      prisma: {} as never,
      emailProvider: emailProvider as never,
      logger,
      intervalMs: 1000,
      minAgeMs: 60_000,
      maxAttempts: 5,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.recordOutboundMessageResendOutcome).toHaveBeenCalledWith({}, 'om-1', {
      status: 'FAILED',
      deliveryError: 'still down',
    });
    expect((logger as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
      { attempted: 1, resent: 0 },
      expect.any(String),
    );

    stop();
  });

  it('releases the claim (never records an outcome) and stops the batch early when the provider is not configured', async () => {
    mocks.findResendableEmailMessages.mockResolvedValue([makeMessage(), makeMessage({ id: 'om-2' })]);
    const emailProvider = {
      name: 'not-configured',
      sendEmail: vi.fn().mockResolvedValue({ status: 'NOT_CONFIGURED' }),
    };

    const stop = startEmailResendSweep({
      prisma: {} as never,
      emailProvider: emailProvider as never,
      logger: makeLogger(),
      intervalMs: 1000,
      minAgeMs: 60_000,
      maxAttempts: 5,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(emailProvider.sendEmail).toHaveBeenCalledTimes(1); // stopped after the first, never tried om-2
    expect(mocks.releaseOutboundMessageResendClaim).toHaveBeenCalledWith({}, 'om-1');
    expect(mocks.recordOutboundMessageResendOutcome).not.toHaveBeenCalled();

    stop();
  });

  it('does not log when nothing is due', async () => {
    mocks.findResendableEmailMessages.mockResolvedValue([]);
    const logger = makeLogger();

    const stop = startEmailResendSweep({
      prisma: {} as never,
      emailProvider: { name: 'fake', sendEmail: vi.fn() } as never,
      logger,
      intervalMs: 1000,
      minAgeMs: 60_000,
      maxAttempts: 5,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect((logger as { info: ReturnType<typeof vi.fn> }).info).not.toHaveBeenCalled();
    stop();
  });

  it('logs and survives a failed sweep instead of crashing the worker (self-heals on the next tick)', async () => {
    mocks.findResendableEmailMessages
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce([]);
    const logger = makeLogger();

    const stop = startEmailResendSweep({
      prisma: {} as never,
      emailProvider: { name: 'fake', sendEmail: vi.fn() } as never,
      logger,
      intervalMs: 1000,
      minAgeMs: 60_000,
      maxAttempts: 5,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect((logger as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.findResendableEmailMessages).toHaveBeenCalledTimes(2);

    stop();
  });
});
