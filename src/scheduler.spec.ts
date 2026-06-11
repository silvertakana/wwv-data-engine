import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./redis', () => ({
  redis: {},
  setLiveSnapshot: vi.fn().mockResolvedValue(undefined),
}));

import {
  registerSeeders,
  startScheduler,
  stopScheduler,
  cronTick,
  getRegisteredPluginIds,
} from './scheduler';
import type { SeederModule } from './seeder-loader';

/** Flush pending microtasks so fire-and-forget runners settle. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function cronSeeder(id: string, cron: string, fn = vi.fn()): SeederModule & { fn: ReturnType<typeof vi.fn> } {
  return { id, name: id, cron, fn };
}

describe('scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('kickstarts cron seeders once at startup', async () => {
    const seeder = cronSeeder('earthquakes', '0 * * * *');
    registerSeeders([seeder]);
    startScheduler();
    await vi.runOnlyPendingTimersAsync();

    expect(seeder.fn).toHaveBeenCalledTimes(1);
  });

  it('fires a matching cron seeder exactly once per matching minute', async () => {
    const seeder = cronSeeder('earthquakes', '0 * * * *');
    registerSeeders([seeder]);
    startScheduler();
    await vi.runOnlyPendingTimersAsync();
    seeder.fn.mockClear();

    const eleven = new Date(2026, 5, 11, 11, 0, 10);

    // The ticker passes over the same minute multiple times — only one run.
    cronTick(eleven);
    cronTick(new Date(2026, 5, 11, 11, 0, 30));
    cronTick(new Date(2026, 5, 11, 11, 0, 50));
    await vi.runOnlyPendingTimersAsync();
    expect(seeder.fn).toHaveBeenCalledTimes(1);

    // Non-matching minutes never fire.
    cronTick(new Date(2026, 5, 11, 11, 1, 10));
    cronTick(new Date(2026, 5, 11, 11, 30, 10));
    await vi.runOnlyPendingTimersAsync();
    expect(seeder.fn).toHaveBeenCalledTimes(1);

    // The next matching hour fires again.
    cronTick(new Date(2026, 5, 11, 12, 0, 10));
    await vi.runOnlyPendingTimersAsync();
    expect(seeder.fn).toHaveBeenCalledTimes(2);
  });

  it('keeps scheduling siblings when one seeder repeatedly throws', async () => {
    const failing = cronSeeder('international-sanctions', '0 * * * *',
      vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const healthy = cronSeeder('earthquakes', '0 * * * *');
    registerSeeders([failing, healthy]);
    startScheduler();
    await vi.runOnlyPendingTimersAsync();
    failing.fn.mockClear();
    healthy.fn.mockClear();

    // The production incident: a sibling's failure at 10:00 must not stop
    // this seeder's 11:00 and 12:00 runs.
    for (const hour of [10, 11, 12]) {
      cronTick(new Date(2026, 5, 11, hour, 0, 10));
      await vi.runOnlyPendingTimersAsync();
    }

    expect(failing.fn).toHaveBeenCalledTimes(3);
    expect(healthy.fn).toHaveBeenCalledTimes(3);
  });

  it('isolates a throwing init so later seeders still get scheduled', async () => {
    const badInit: SeederModule = {
      id: 'maritime',
      name: 'maritime',
      init: () => { throw new Error('websocket exploded'); },
    };
    const after = cronSeeder('earthquakes', '0 * * * *');
    registerSeeders([badInit, after]);

    expect(() => startScheduler()).not.toThrow();
    await vi.runOnlyPendingTimersAsync();
    expect(after.fn).toHaveBeenCalledTimes(1); // kickstart ran
  });

  it('skips a seeder with an invalid cron expression but schedules the rest', async () => {
    const broken = cronSeeder('broken', 'every full moon');
    const fine = cronSeeder('earthquakes', '0 * * * *');
    registerSeeders([broken, fine]);

    expect(() => startScheduler()).not.toThrow();
    await vi.runOnlyPendingTimersAsync();

    expect(broken.fn).not.toHaveBeenCalled();
    expect(fine.fn).toHaveBeenCalledTimes(1);

    fine.fn.mockClear();
    cronTick(new Date(2026, 5, 11, 11, 0, 10));
    await vi.runOnlyPendingTimersAsync();
    expect(broken.fn).not.toHaveBeenCalled();
    expect(fine.fn).toHaveBeenCalledTimes(1);
  });

  it('runs interval seeders and exposes registered ids', async () => {
    const fetch = vi.fn().mockResolvedValue([{ id: 'x' }]);
    const seeder: SeederModule = { id: 'fr24-flights', name: 'fr24-flights', interval: 30_000, fetch };
    registerSeeders([seeder]);
    startScheduler();

    await vi.advanceTimersByTimeAsync(0); // kickstart
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);

    expect(getRegisteredPluginIds()).toEqual(['fr24-flights']);
  });
});
