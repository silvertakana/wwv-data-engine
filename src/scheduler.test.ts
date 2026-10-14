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
    // Broadcasts: ok(run1) + stale(run2) + ok(run4) = 3 frames total.
    expect(broadcastSeederStatusMock).toHaveBeenCalledTimes(3);
    expect(broadcastSeederStatusMock).toHaveBeenCalledWith('seed-run', expect.objectContaining({
      status: 'stale',
      lastGood: fetchedAtOfSuccessCall(0),
    }));
    expect(seederMeta['seed-run'].failureCount).toBe(2);
    expect(seederMeta['seed-run'].itemsSeen).toBe(1);
    expect(seederMeta['seed-run'].lastError).toBeNull();

    // The run-3 repeat failure was debounced: still exactly one stale frame
    // (the two ok frames come from the successful runs, not the failures).
    expect(broadcastSeederStatusMock).toHaveBeenCalledTimes(3);
    expect(broadcastSeederStatusMock.mock.calls.filter(c => (c[1] as { status?: string }).status === 'stale')).toHaveLength(1);
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
    expect(broadcastSeederStatusMock).toHaveBeenCalledWith('seed-first', expect.objectContaining({
      status: 'stale',
      lastGood: null,
    }));
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

    // Failure (emit #1) -> success (reset + ok frame) -> failure (emit #2).
    expect(broadcastSeederStatusMock).toHaveBeenCalledTimes(3);
    expect(broadcastSeederStatusMock).toHaveBeenLastCalledWith('seed-reemit', expect.objectContaining({
      status: 'stale',
      lastGood: fetchedAtOfSuccessCall(0),
    }));
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

    expect(broadcastSeederStatusMock).toHaveBeenCalledWith('seed-cron', expect.objectContaining({
      status: 'stale',
      lastGood: null,
    }));
    expect(seederMeta['seed-cron'].failureCount).toBe(1);
    expect(seederMeta['seed-cron'].lastError).toBe('cron boom');
  });

  it('cron success records through the SAME path as interval seeders (ok frame + reset metrics)', async () => {
    const fnMock = vi.fn().mockResolvedValue(undefined);
    registerSeeders([freshCronSeeder('seed-cron-ok', fnMock)]);
    startScheduler();

    // The kickstart run fires synchronously-bound during startScheduler.
    await runIntervals(0);

    // Success on the cron path must emit an ok frame carrying the wire-contract
    // health payload — the single choke point shared with interval seeders.
    expect(broadcastSeederStatusMock).toHaveBeenCalledTimes(1);
    const okCall = broadcastSeederStatusMock.mock.calls[0];
    expect(okCall[0]).toBe('seed-cron-ok');
    expect(okCall[1]).toMatchObject({ status: 'ok', lastGood: expect.any(String) });
    expect(okCall[1]).toHaveProperty('health');
    expect((okCall[1] as { health: { pluginId: string } }).health.pluginId).toBe('seed-cron-ok');
    expect(seederMeta['seed-cron-ok'].lastRun).toBeTypeOf('number');
    expect(seederMeta['seed-cron-ok'].failureCount).toBe(0);
    expect(seederMeta['seed-cron-ok'].lastError).toBeNull();
    // The cron cadence was captured at registration: the wire payload carries it.
    expect((okCall[1] as { health: { cron: string | null } }).health.cron).toBe('* * * * *');
  });

  it('data-falsy return is treated as a failure', async () => {
    const fetchMock: FetchMock = vi.fn().mockResolvedValueOnce(null);
    registerSeeders([freshSeeder('seed-falsy', fetchMock)]);
    startScheduler();

    await runIntervals(1);

    expect(broadcastSeederStatusMock).toHaveBeenCalledWith('seed-falsy', expect.objectContaining({
      status: 'stale',
      lastGood: null,
    }));
    expect(seederMeta['seed-falsy'].failureCount).toBe(1);
    expect(seederMeta['seed-falsy'].lastError).toBe('Seeder returned no data');
  });
});

// ---- Component F: interval-seeder overlap guard -----------------------------
// An interval seeder whose fetch outlives its own cadence must not stack runs.
// The guard is per-seeder and released in a finally block, so success, failure
// and rejection all let the NEXT scheduled tick through. These tests drive a
// pending fetch across several intervals on the existing fake-timer harness and
// count seeder.fetch invocations, which is the run count.
describe('scheduler interval overlap guard', () => {
  type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
  };

  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // A seeder whose fetch never settles on its own: every call returns a fresh
  // pending promise, and the test decides when (and how) each one settles.
  // Returning the SAME promise from every call would make one rejection look
  // like many failures, which is not how a real seeder behaves.
  function pendingFetch() {
    const pending: Deferred<unknown>[] = [];
    const fn = vi.fn(() => {
      const d = deferred<unknown>();
      pending.push(d);
      return d.promise;
    });
    return {
      fn,
      /** Settle the oldest still-pending call successfully. */
      resolveOldest: (value: unknown) => {
        const d = pending.shift();
        if (!d) throw new Error('no pending seeder fetch to resolve');
        d.resolve(value);
      },
      /** Reject the oldest still-pending call. */
      rejectOldest: (reason: unknown) => {
        const d = pending.shift();
        if (!d) throw new Error('no pending seeder fetch to reject');
        d.reject(reason);
      },
    };
  }

  const fetchedAtOfLiveSnapshot = (callIndex: number): string => {
    const payload = setLiveSnapshotMock.mock.calls[callIndex]?.[1] as { fetchedAt: string } | undefined;
    if (!payload) throw new Error(`No setLiveSnapshot call at index ${callIndex}`);
    return payload.fetchedAt;
  };

  it('F1: a run pending across several intervals yields at most one run (old code starts one per tick)', async () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    registerSeeders([freshSeeder('seed-overlap', fetchMock)]);
    startScheduler();

    // Kickstart fires, then four interval ticks fire while it is still pending.
    await vi.advanceTimersByTimeAsync(4000);

    // Old code: 1 kickstart + 4 overlapping ticks = 5 concurrent runs.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('F2: resolving the pending run lets the next scheduled tick run again, once per tick, in order', async () => {
    const { fn, resolveOldest } = pendingFetch();
    registerSeeders([freshSeeder('seed-resolve', fn)]);
    startScheduler();

    // Kickstart fires, then four interval ticks arrive while it is still in
    // flight and the guard drops every one of them: still exactly one run, and
    // not a single snapshot written for a run that has not completed.
    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(setLiveSnapshotMock).not.toHaveBeenCalled();

    // The in-flight kickstart finally succeeds. The guard is released by the time
    // the next scheduled tick arrives, so it runs: one run per interval tick from
    // here, with no catch-up burst for the four intervals already skipped.
    resolveOldest([{ id: 1 }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    // One write and one ok broadcast per completed run, never two for one run.
    expect(setLiveSnapshotMock).toHaveBeenCalledTimes(1);
    const okFrames = broadcastSeederStatusMock.mock.calls.filter(c => (c[1] as { status?: string }).status === 'ok');
    expect(okFrames).toHaveLength(1);

    // The write came from the run that completed, carrying its own ISO stamp and
    // item count, and the seeder's own health record stayed clean.
    const payload = setLiveSnapshotMock.mock.calls[0]?.[1] as { source: string; fetchedAt: string; totalCount: number } | undefined;
    expect(payload?.source).toBe('seed-resolve');
    expect(payload?.fetchedAt).toBe(fetchedAtOfLiveSnapshot(0));
    expect(payload?.totalCount).toBe(1);
    expect(seederMeta['seed-resolve'].failureCount).toBe(0);
  });

  it('F3: a rejected pending run clears the guard so the next tick recovers (finally on the failure path)', async () => {
    const { fn, rejectOldest, resolveOldest } = pendingFetch();
    registerSeeders([freshSeeder('seed-reject-recover', fn)]);
    startScheduler();

    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(1);

    // Reject the in-flight run; the next scheduled tick must be allowed through.
    rejectOldest(new Error('upstream timeout'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(seederMeta['seed-reject-recover'].failureCount).toBe(1);
    expect(seederMeta['seed-reject-recover'].lastError).toBe('upstream timeout');

    resolveOldest([{ id: 'recovered' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(3);

    // The recovery run records a clean success.
    expect(seederMeta['seed-reject-recover'].itemsSeen).toBe(1);
    expect(seederMeta['seed-reject-recover'].lastError).toBeNull();
    expect(setLiveSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it('F4: a slow seeder never blocks another seeder; guards are per-seeder', async () => {
    const fastFetch = vi.fn().mockResolvedValue([{ id: 'fast' }]);
    const { fn, resolveOldest } = pendingFetch();
    registerSeeders([freshSeeder('seed-slow', fn), freshSeeder('seed-fast', fastFetch)]);
    startScheduler();

    await vi.advanceTimersByTimeAsync(2000);
    expect(fastFetch).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenCalledTimes(1);

    resolveOldest([{ id: 'slow-1' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fastFetch).toHaveBeenCalledTimes(4);
    expect(seederMeta['seed-fast'].failureCount).toBe(0);
  });

  it('F5: skipped ticks are dropped, not queued - runs are exactly one per interval that finds no run in flight', async () => {
    const { fn, resolveOldest } = pendingFetch();
    registerSeeders([freshSeeder('seed-noqueue', fn)]);
    startScheduler();

    // Five interval ticks fire while the kickstart is still in flight: one run.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(setLiveSnapshotMock).not.toHaveBeenCalled();

    resolveOldest([{ id: 1 }]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(setLiveSnapshotMock).toHaveBeenCalledTimes(1);

    resolveOldest([{ id: 2 }]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(3);

    // Seven ticks fired, three runs happened: no catch-up burst for the
    // intervals the guard deliberately skipped while a run was in flight.
    expect(setLiveSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it('F6: guard release when the stop path rejects keeps later ticks alive and records exactly one failure', async () => {
    const { fn, rejectOldest, resolveOldest } = pendingFetch();
    registerSeeders([freshSeeder('seed-stop-release', fn)]);
    startScheduler();

    // Drain the pending kickstart to a rejection so the next tick must run.
    await vi.advanceTimersByTimeAsync(1000);
    rejectOldest(new Error('seeder stopped mid-run'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(seederMeta['seed-stop-release'].failureCount).toBe(1);

    resolveOldest([{ id: 'after-stop' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(seederMeta['seed-stop-release'].itemsSeen).toBe(1);
  });

  it('F7: a still-pending kickstart emits no status frame until it settles, and a rejection still reaches the stale path', async () => {
    const { fn, rejectOldest } = pendingFetch();
    registerSeeders([freshSeeder('seed-envelope', fn)]);
    startScheduler();

    // A run still in flight emits nothing at all: no frame while it is pending,
    // and no second run to emit one either.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(broadcastSeederStatusMock).not.toHaveBeenCalled();

    rejectOldest(new Error('first run died'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(broadcastSeederStatusMock).toHaveBeenCalledTimes(1);
    expect(broadcastSeederStatusMock).toHaveBeenCalledWith('seed-envelope', expect.objectContaining({
      status: 'stale',
      lastGood: null,
    }));
    expect(seederMeta['seed-envelope'].failureCount).toBe(1);
  });
});
