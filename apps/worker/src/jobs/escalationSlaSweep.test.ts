import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findBreachedEscalationCases: vi.fn(),
  markEscalationCaseSlaBreached: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  findBreachedEscalationCases: mocks.findBreachedEscalationCases,
  markEscalationCaseSlaBreached: mocks.markEscalationCaseSlaBreached,
}));

const { startEscalationSlaSweep } = await import('./escalationSlaSweep.js');

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() } as never;
}

describe('startEscalationSlaSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks every breached case on each tick and logs the count', async () => {
    mocks.findBreachedEscalationCases.mockResolvedValue([{ id: 'case-1' }, { id: 'case-2' }]);
    mocks.markEscalationCaseSlaBreached.mockResolvedValue(undefined);
    const logger = makeLogger();

    const stop = startEscalationSlaSweep({ prisma: {} as never, logger, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.findBreachedEscalationCases).toHaveBeenCalledTimes(1);
    expect(mocks.markEscalationCaseSlaBreached).toHaveBeenCalledTimes(2);
    expect(mocks.markEscalationCaseSlaBreached).toHaveBeenCalledWith(expect.anything(), 'case-1');
    expect(mocks.markEscalationCaseSlaBreached).toHaveBeenCalledWith(expect.anything(), 'case-2');
    expect((logger as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
      { count: 2 },
      expect.any(String),
    );

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.findBreachedEscalationCases).toHaveBeenCalledTimes(1); // no further ticks after stop()
  });

  it('does not log or mark anything when nothing is breached', async () => {
    mocks.findBreachedEscalationCases.mockResolvedValue([]);
    const logger = makeLogger();

    const stop = startEscalationSlaSweep({ prisma: {} as never, logger, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.markEscalationCaseSlaBreached).not.toHaveBeenCalled();
    expect((logger as { info: ReturnType<typeof vi.fn> }).info).not.toHaveBeenCalled();
    stop();
  });

  it('logs and survives a failed sweep instead of crashing the worker (self-heals on the next tick)', async () => {
    mocks.findBreachedEscalationCases
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce([]);
    const logger = makeLogger();

    const stop = startEscalationSlaSweep({ prisma: {} as never, logger, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect((logger as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.findBreachedEscalationCases).toHaveBeenCalledTimes(2);

    stop();
  });
});
