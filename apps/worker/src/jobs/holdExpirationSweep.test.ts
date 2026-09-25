import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  expireDueHolds: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  expireDueHolds: mocks.expireDueHolds,
}));

const { startHoldExpirationSweep } = await import('./holdExpirationSweep.js');

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() } as never;
}

describe('startHoldExpirationSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls expireDueHolds on each tick and logs when holds were actually expired', async () => {
    mocks.expireDueHolds.mockResolvedValue(3);
    const logger = makeLogger();

    const stop = startHoldExpirationSweep({ prisma: {} as never, logger, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.expireDueHolds).toHaveBeenCalledTimes(1);
    expect((logger as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
      { count: 3 },
      expect.any(String),
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.expireDueHolds).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.expireDueHolds).toHaveBeenCalledTimes(2); // no further ticks after stop()
  });

  it('does not log when nothing was due', async () => {
    mocks.expireDueHolds.mockResolvedValue(0);
    const logger = makeLogger();

    const stop = startHoldExpirationSweep({ prisma: {} as never, logger, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    expect((logger as { info: ReturnType<typeof vi.fn> }).info).not.toHaveBeenCalled();
    stop();
  });

  it('logs and survives a failed sweep instead of crashing the worker (self-heals on the next tick)', async () => {
    mocks.expireDueHolds
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(1);
    const logger = makeLogger();

    const stop = startHoldExpirationSweep({ prisma: {} as never, logger, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect((logger as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.expireDueHolds).toHaveBeenCalledTimes(2);
    expect((logger as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
      { count: 1 },
      expect.any(String),
    );

    stop();
  });
});
