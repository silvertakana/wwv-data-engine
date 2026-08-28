import { describe, expect, it } from 'vitest';
import {
  CRON_GRACE_MIN_MS,
  MIN_EXPECTED_MAX_AGE_MS,
  cronPeriodMs,
  deriveExpectedMaxAgeMs,
  deriveSeederHealth,
} from './seeder-health';
import type { SeederMeta } from './scheduler';

describe('cronPeriodMs — pure cron period estimation', () => {
  it('returns the minute gap for a per-minute cron', () => {
    expect(cronPeriodMs('* * * * *')).toBe(60_000);
  });

  it('returns the hour gap for an hourly cron', () => {
    expect(cronPeriodMs('0 * * * *')).toBe(3_600_000);
  });

  it('returns the day gap for a daily cron', () => {
    expect(cronPeriodMs('0 0 * * *')).toBe(86_400_000);
  });

  it('returns the month gap for a monthly cron', () => {
    expect(cronPeriodMs('0 0 1 * *')).toBe(2_678_400_000); // 31 days
  });

  it('returns the year gap for a yearly cron (365/366 days across the window)', () => {
    // Two fires at least one calendar year apart are inside the 5-year window.
    const period = cronPeriodMs('0 0 1 1 *');
    expect(period).not.toBeNull();
    expect(period!).toBeGreaterThanOrEqual(365 * 86_400_000);
    expect(period!).toBeLessThanOrEqual(366 * 86_400_000);
  });

  it('supports step values and ranges', () => {
    expect(cronPeriodMs('*/10 * * * *')).toBe(600_000);
    // Hourly within the range; the LONGEST gap is the overnight 17:30 -> 09:30.
    expect(cronPeriodMs('30 9-17 * * *')).toBe(16 * 3_600_000);
  });

  it('maps 7 to Sunday in the day-of-week field', () => {
    // Sunday-only: period is exactly 7 days.
    expect(cronPeriodMs('0 0 * * 0')).toBe(7 * 86_400_000);
    expect(cronPeriodMs('0 0 * * 7')).toBe(7 * 86_400_000);
  });

  it('applies standard cron dom/dow OR semantics when both are restricted', () => {
    // Every 1st of month OR every Sunday: Sundays recur every 7 days, so the
    // longest gap between consecutive fires is one week.
    expect(cronPeriodMs('0 0 1 * 0')).toBe(7 * 86_400_000);
  });

  it('returns null for invalid or never-firing expressions', () => {
    expect(cronPeriodMs('not a cron')).toBeNull();
    expect(cronPeriodMs('* * * *')).toBeNull(); // 4 fields
    expect(cronPeriodMs('* * * * * *')).toBeNull(); // 6 fields (not supported)
    expect(cronPeriodMs('0 0 31 2 *')).toBeNull(); // Feb 31 never fires
  });
});

describe('deriveExpectedMaxAgeMs — per-seeder cadence derivation (never a global threshold)', () => {
  it('interval seeders: max(3 x interval, floor)', () => {
    expect(deriveExpectedMaxAgeMs({ intervalMs: 10_000 })).toBe(60_000); // 30s vs 60s floor
    expect(deriveExpectedMaxAgeMs({ intervalMs: 60_000 })).toBe(180_000);
    expect(deriveExpectedMaxAgeMs({ intervalMs: 100_000 })).toBe(300_000);
    // Floor applies: a 1s dev interval cannot flap the stale flag.
    expect(deriveExpectedMaxAgeMs({ intervalMs: 1_000 })).toBe(MIN_EXPECTED_MAX_AGE_MS);
  });

  it('cron seeders: period + grace, floored', () => {
    const daily = deriveExpectedMaxAgeMs({ cron: '0 0 * * *' });
    expect(daily).toBe(86_400_000 + Math.max(86_400_000 / 2, CRON_GRACE_MIN_MS));
    // A 5-minute cron: period + max(period/2, grace floor).
    const fiveMin = deriveExpectedMaxAgeMs({ cron: '*/5 * * * *' });
    expect(fiveMin).toBe(300_000 + Math.max(150_000, CRON_GRACE_MIN_MS));
  });

  it('interval wins over cron when both are declared', () => {
    expect(deriveExpectedMaxAgeMs({ intervalMs: 10_000, cron: '0 0 * * *' })).toBe(60_000);
  });

  it('returns null when no cadence is declared', () => {
    expect(deriveExpectedMaxAgeMs({})).toBeNull();
    expect(deriveExpectedMaxAgeMs({ intervalMs: 0 })).toBeNull();
    expect(deriveExpectedMaxAgeMs({ cron: 'bogus' })).toBeNull();
  });
});

describe('deriveSeederHealth — wire-contract payload derivation', () => {
  const baseMeta: SeederMeta = {
    lastRun: null,
    lastError: null,
    failureCount: 0,
    itemsSeen: 0,
    intervalMs: null,
    cron: null,
    expectedMaxAgeMs: null,
  };

  it('never-stale when no run has completed yet (kickstart in flight)', () => {
    const health = deriveSeederHealth('seed-x', baseMeta, 1_000_000);
    expect(health.stale).toBe(false);
    expect(health.lastRun).toBeNull();
  });

  it('stale when now - lastRun exceeds the cadence-derived max age', () => {
    const meta: SeederMeta = {
      ...baseMeta,
      lastRun: 0,
      expectedMaxAgeMs: 60_000,
      intervalMs: 10_000,
    };
    expect(deriveSeederHealth('seed-x', meta, 61_000).stale).toBe(true);
    expect(deriveSeederHealth('seed-x', meta, 60_000).stale).toBe(false); // boundary: not strictly greater
  });

  it('not stale when no cadence is known even after a long idle', () => {
    const meta: SeederMeta = { ...baseMeta, lastRun: 0, expectedMaxAgeMs: null };
    expect(deriveSeederHealth('seed-x', meta, 10 ** 12).stale).toBe(false);
  });

  it('null-coalesces partial meta so the wire shape always carries every key', () => {
    const health = deriveSeederHealth('seed-x', {} as SeederMeta, 0);
    expect(health).toEqual({
      pluginId: 'seed-x',
      lastRun: null,
      lastError: null,
      failureCount: 0,
      intervalMs: null,
      cron: null,
      expectedMaxAgeMs: null,
      stale: false,
    });
  });

  it('carries cadence + error telemetry through to the payload', () => {
    const meta: SeederMeta = {
      ...baseMeta,
      lastRun: 42,
      lastError: 'boom',
      failureCount: 3,
      intervalMs: 5_000,
      cron: null,
      expectedMaxAgeMs: 15_000,
    };
    const health = deriveSeederHealth('seed-x', meta, 42);
    expect(health).toEqual({
      pluginId: 'seed-x',
      lastRun: 42,
      lastError: 'boom',
      failureCount: 3,
      intervalMs: 5_000,
      cron: null,
      expectedMaxAgeMs: 15_000,
      stale: false,
    });
  });
});
