import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeederContext, SeederModule } from './seeder-loader';

// Hoisted mock fns shared by the module factories below. broadcastSeederStatus
// is the change-C helper integration point under test; sabotaging it proves the
// scheduler's try/catch never lets a broadcast failure kill a timer tick.
const { broadcastPluginDataMock, broadcastSeederStatusMock, setLiveSnapshotMock } = vi.hoisted(() => ({
  broadcastPluginDataMock: vi.fn(),
  broadcastSeederStatusMock: vi.fn(),
  setLiveSnapshotMock: vi.fn(),
}));

vi.mock('./websocket', () => ({
  broadcastPluginData: broadcastPluginDataMock,
  broadcastSeederStatus: broadcastSeederStatusMock,
}));

vi.mock('./redis', () => ({
  redis: { on: vi.fn() } as never,
  setLiveSnapshot: setLiveSnapshotMock,
}));

import { registerSeeders, seederMeta, seederStatus, startScheduler } from './scheduler';

type FetchMock = (ctx: SeederContext) => Promise<unknown>;

function freshSeeder(id: string, fetch: FetchMock): SeederModule {
  return { id, name: id, interval: 1000, fetch };
}

function freshCronSeeder(id: string, fn: (ctx: SeederContext) => Promise<unknown> | void): SeederModule {
  return { id, name: id, cron: '* * * * *', fn };
}

// Reset module-level metric/status registries between tests. The stale/lastGood
// bookkeeping lives in module-scoped Maps not exported here, so each test uses a
// unique seeder id to avoid cross-test coupling from leftover state.
function resetRegistries() {
  for (const key of Object.keys(seederMeta)) delete seederMeta[key];
  for (const key of Object.keys(seederStatus)) delete seederStatus[key];
}

async function runIntervals(count: number, interval = 1000) {
  // Count N total runs: the initial kickstart in startScheduler is run 1, and
  // each interval tick is a further run, so N-1 advances cover N runs.
  if (count > 1) {
    await vi.advanceTimersByTimeAsync(interval * (count - 1));
  } else {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function fetchedAtOfSuccessCall(callIndex: number): string {
  const payload = setLiveSnapshotMock.mock.calls[callIndex]?.[1] as { fetchedAt: string } | undefined;
  if (!payload) throw new Error(`No setLiveSnapshot call at index ${callIndex}`);
  return payload.fetchedAt;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRegistries();
  broadcastSeederStatusMock.mockReset();
  setLiveSnapshotMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler stale/error envelope', () => {
  it('AC-A1: emits stale frame with lastGood from prior success, debounces consecutive failures, resumes normally', async () => {
    const fetchMock: FetchMock = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1 }])
      .mockRejectedValueOnce(new Error('boom1'))
      .mockRejectedValueOnce(new Error('boom2'))
      .mockResolvedValueOnce([{ id: 2 }]);
    registerSeeders([freshSeeder('seed-run', fetchMock)]);
    startScheduler();

    await runIntervals(4);

    // Run 4 succeeded: final state has 2 failures (boom1, boom2), itemsSeen from
    // the latest successful array, and lastError cleared by the success reset.
    expect(broadcastSeederStatusMock).toHaveBeenCalledTimes(1);
    expect(broadcastSeederStatusMock).toHaveBeenCalledWith('seed-run', {
      status: 'stale',
      lastGood: fetchedAtOfSuccessCall(0),
    });
    expect(seederMeta['seed-run'].failureCount).toBe(2);
    expect(seederMeta['seed-run'].itemsSeen).toBe(1);
    expect(seederMeta['seed-run'].lastError).toBeNull();

    // The run-3 repeat failure was debounced: still exactly one stale frame,
    // and seederStatus only reflects successes.
    expect(broadcastSeederStatusMock).toHaveBeenCalledTimes(1);
  });

  it('AC-A2: stale path drives broadcastSeederStatus with the correct pluginId/status shape', async () => {
    const fetchMock: FetchMock = vi.fn().mockRejectedValueOnce(new Error('kaboom'));
    registerSeeders([freshSeeder('seed-shape', fetchMock)]);
    startScheduler();

    await runIntervals(1);

    // Integration check on the change-C helper: scheduler supplies pluginId and
    // a SeederStatus object; the helper appends type:'status' (covered there).
    expect(broadcastSeederStatusMock).toHaveBeenCalledTimes(1);
    expect(broadcastSeederStatusMock).toHaveBeenCalledWith(
      'seed-shape',
      expect.objectContaining({ status: 'stale' }),
    );
  });

  it('AC-A3: three consecutive failures keep the process/interval alive (broadcast throw is swallowed)', async () => {
    const fetchMock: FetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('f1'))
      .mockRejectedValueOnce(new Error('f2'))
      .mockRejectedValueOnce(new Error('f3'))
      .mockResolvedValueOnce([{ id: 99 }]);
    registerSeeders([freshSeeder('seed-alive', fetchMock)]);
    startScheduler();

    // Sabotage the broadcast so a throw is the exact thing being guarded.
    broadcastSeederStatusMock.mockImplementation(() => {
      throw new Error('broadcast broken');
    });

    // Runs 1 (kickstart) + next 2 ticks = 3 consecutive failures.
    await vi.advanceTimersByTimeAsync(2000);
    expect(seederMeta['seed-alive'].failureCount).toBe(3);

    // Interval is still scheduled: a further tick still executes the seeder,
    // proving the throwing broadcast never killed the timer loop.
    await vi.advanceTimersByTimeAsync(1000);
    expect(seederMeta['seed-alive'].failureCount).toBe(3);
    expect(seederMeta['seed-alive'].itemsSeen).toBe(1);
  });

  it('AC-A4: first-ever failure emits lastGood:null without throwing', async () => {
    const fetchMock: FetchMock = vi.fn().mockRejectedValueOnce(new Error('first fail'));
    registerSeeders([freshSeeder('seed-first', fetchMock)]);
    startScheduler();

    await runIntervals(1);

    expect(broadcastSeederStatusMock).toHaveBeenCalledTimes(1);
    expect(broadcastSeederStatusMock).toHaveBeenCalledWith('seed-first', {
      status: 'stale',
      lastGood: null,
    });
    expect(seederMeta['seed-first'].failureCount).toBe(1);
  });

  it('successful run clears the stale debounce so a later failure re-emits', async () => {
    const fetchMock: FetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail-before'))
      .mockResolvedValueOnce([{ id: 1 }])
      .mockRejectedValueOnce(new Error('fail-after'));
    registerSeeders([freshSeeder('seed-reemit', fetchMock)]);
    startScheduler();

    await runIntervals(3);

    // Failure (emit #1) -> success (reset) -> failure (emit #2).
    expect(broadcastSeederStatusMock).toHaveBeenCalledTimes(2);
    expect(broadcastSeederStatusMock).toHaveBeenLastCalledWith('seed-reemit', {
      status: 'stale',
      lastGood: fetchedAtOfSuccessCall(0),
    });
  });

  it('records itemsSeen on success and truncates lastError to 200 chars', async () => {
    const longMessage = 'x'.repeat(500);
    const fetchMock: FetchMock = vi
      .fn()
      .mockResolvedValueOnce([{ a: 1 }, { b: 2 }, { c: 3 }])
      .mockRejectedValueOnce(new Error(longMessage));
    registerSeeders([freshSeeder('seed-trunc', fetchMock)]);
    startScheduler();

    await runIntervals(2);

    expect(seederMeta['seed-trunc'].itemsSeen).toBe(3);
    expect(seederMeta['seed-trunc'].lastError).toBe(longMessage.slice(0, 200));
    expect(seederMeta['seed-trunc'].lastError!.length).toBeLessThanOrEqual(200);
  });

  it('cron runner applies the same failure handling (stale frame + metrics)', async () => {
    const fnMock = vi.fn().mockRejectedValueOnce(new Error('cron boom'));
    registerSeeders([freshCronSeeder('seed-cron', fnMock)]);
    startScheduler();

    // The kickstart run fires synchronously-bound during startScheduler.
    await runIntervals(0);

    expect(broadcastSeederStatusMock).toHaveBeenCalledWith('seed-cron', {
      status: 'stale',
      lastGood: null,
    });
    expect(seederMeta['seed-cron'].failureCount).toBe(1);
    expect(seederMeta['seed-cron'].lastError).toBe('cron boom');
  });

  it('data-falsy return is treated as a failure', async () => {
    const fetchMock: FetchMock = vi.fn().mockResolvedValueOnce(null);
    registerSeeders([freshSeeder('seed-falsy', fetchMock)]);
    startScheduler();

    await runIntervals(1);

    expect(broadcastSeederStatusMock).toHaveBeenCalledWith('seed-falsy', {
      status: 'stale',
      lastGood: null,
    });
    expect(seederMeta['seed-falsy'].failureCount).toBe(1);
    expect(seederMeta['seed-falsy'].lastError).toBe('Seeder returned no data');
  });
});
