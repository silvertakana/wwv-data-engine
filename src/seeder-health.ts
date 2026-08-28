/**
 * Cadence-aware per-seeder health telemetry.
 *
 * Every staleness decision is derived from the seeder's OWN declared cadence
 * (interval or cron expression). There is deliberately NO global staleness
 * threshold anywhere in this module or its callers.
 */
import type { SeederMeta } from './scheduler';

/**
 * WIRE CONTRACT — per-seeder health payload.
 *
 * The globe (worldwideview) MIRRORS this shape by hand in its own TypeScript;
 * it never imports engine code. Any field change here is a wire-contract
 * change: bump semver (minor for additive, major for breaking/renamed) and
 * spell the diff out in the PR body so globe can mirror it.
 *
 * Delivered over WebSocket as `health` on `{ type: 'status', pluginId, ... }`
 * frames and over HTTP in the `/health` response under `seederHealth`.
 */
export interface SeederHealth {
  pluginId: string;
  /** Epoch ms of the last run attempt (success or failure). null = never ran. */
  lastRun: number | null;
  /** Last error message, truncated to 200 chars. Cleared on success. */
  lastError: string | null;
  /** Lifetime count of failed runs. */
  failureCount: number;
  /** Declared interval cadence in ms. null for cron (or unknown) seeders. */
  intervalMs: number | null;
  /** Declared cron expression verbatim. null for interval seeders. */
  cron: string | null;
  /**
   * Max age (ms) a snapshot from this seeder may have before it is stale,
   * derived from the seeder's own cadence:
   *   interval seeder -> max(3 x interval, MIN_EXPECTED_MAX_AGE_MS)
   *   cron seeder     -> max(cronPeriod + grace, MIN_EXPECTED_MAX_AGE_MS)
   * null when the seeder declares no (parseable) cadence.
   */
  expectedMaxAgeMs: number | null;
  /**
   * true when lastRun is known, a cadence is known, and
   * now - lastRun > expectedMaxAgeMs. A seeder that has never completed a
   * run attempt is conservatively not stale yet (the kickstart may be in
   * flight).
   */
  stale: boolean;
}

// Floor for expectedMaxAgeMs so a sub-second dev interval cannot flap the
// stale flag on every scheduler tick.
export const MIN_EXPECTED_MAX_AGE_MS = 60_000;

// Minimum grace added on top of a cron period. A cron seeder's period is the
// gap between fires; the grace absorbs one skipped/overlapping tick.
export const CRON_GRACE_MIN_MS = 5 * 60_000;

type CronField = {
  any: boolean;
  values: Set<number>;
};

const MINUTE_MS = 60_000;

function parseCronField(raw: string, min: number, max: number): CronField | null {
  const field: CronField = { any: true, values: new Set() };
  for (const part of raw.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      if (stepPart === undefined) continue; // '*' alone: field stays unrestricted
      lo = min;
      hi = max;
    } else {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(rangePart);
      if (rangeMatch) {
        lo = Number(rangeMatch[1]);
        hi = Number(rangeMatch[2]);
      } else if (/^\d+$/.test(rangePart)) {
        lo = Number(rangePart);
        hi = stepPart === undefined ? lo : max;
      } else {
        return null;
      }
    }
    if (lo < min || hi > max || lo > hi) return null;
    field.any = false;
    for (let v = lo; v <= hi; v += step) field.values.add(v);
  }
  return field;
}

/**
 * Estimates the firing period of a 5-field cron expression (minute hour
 * dom month dow) in ms, as the LONGEST gap between consecutive fires across
 * a 5-year window (starting 2024-01-01, a leap year, Monday). Pure and
 * deterministic. Returns null for invalid or never-firing expressions.
 *
 * The longest gap is the worst case a seeder legitimately waits between
 * refreshes, which is what a staleness threshold must tolerate: a monthly
 * cron (`0 0 1 * *`) waits up to 31 days after a 31-day month, so flagging
 * stale at the shortest month gap (28 days) would false-positive.
 *
 * Follows standard cron semantics: when both dom and dow are restricted
 * (neither is '*'), a minute matches if EITHER matches.
 */
export function cronPeriodMs(expression: string): number | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dom = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12);
  // 7 is an alias for Sunday (0) in cron's day-of-week field.
  const dowRaw = parseCronField(fields[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  const dow: CronField = {
    any: dowRaw.any,
    values: new Set([...dowRaw.values].map(v => (v === 7 ? 0 : v))),
  };

  // Deterministic anchor: 2024-01-01T00:00:00Z (Monday). The window covers
  // five years (two leap years), so every realistic seeder cadence — minutes
  // through yearly, including leap-day crons — has at least two fires inside
  // it, and the longest gap between consecutive fires is the period.
  const BASE_MS = Date.UTC(2024, 0, 1);
  const WINDOW_MINUTES = 5 * 366 * 24 * 60;

  let lastFire = -1;
  let maxGap = -1;

  for (let i = 0; i < WINDOW_MINUTES; i++) {
    const t = i * MINUTE_MS;
    const date = new Date(BASE_MS + t);
    const domOk = dom.any || dom.values.has(date.getUTCDate());
    const dowOk = dow.any || dow.values.has(date.getUTCDay());
    // Standard cron: both restricted means OR, either restricted means the
    // restricted one governs, neither restricted means always ok.
    const dayOk = dom.any && dow.any ? true : dom.any ? dowOk : dow.any ? domOk : domOk || dowOk;
    const monthOk = month.any || month.values.has(date.getUTCMonth() + 1);
    const hourOk = hour.any || hour.values.has(date.getUTCHours());
    const minuteOk = minute.any || minute.values.has(date.getUTCMinutes());
    if (!dayOk || !monthOk || !hourOk || !minuteOk) {
      continue;
    }
    if (lastFire >= 0) {
      const gap = t - lastFire;
      if (gap > maxGap) maxGap = gap;
    }
    lastFire = t;
  }

  return maxGap >= 0 ? maxGap : null;
}

/**
 * Derives the per-seeder maximum snapshot age before staleness, from the
 * seeder's own declared cadence. Never a global threshold.
 *
 *   interval seeder: max(3 x intervalMs, MIN_EXPECTED_MAX_AGE_MS)
 *   cron seeder:     max(cronPeriod + grace, MIN_EXPECTED_MAX_AGE_MS),
 *                    grace = max(period / 2, CRON_GRACE_MIN_MS)
 *
 * Returns null when neither an interval nor a parseable cron is declared.
 */
export function deriveExpectedMaxAgeMs(cadence: { intervalMs?: number; cron?: string }): number | null {
  if (typeof cadence.intervalMs === 'number' && cadence.intervalMs > 0) {
    return Math.max(cadence.intervalMs * 3, MIN_EXPECTED_MAX_AGE_MS);
  }
  if (typeof cadence.cron === 'string' && cadence.cron.length > 0) {
    const period = cronPeriodMs(cadence.cron);
    if (period !== null) {
      const grace = Math.max(period / 2, CRON_GRACE_MIN_MS);
      return Math.max(period + grace, MIN_EXPECTED_MAX_AGE_MS);
    }
  }
  return null;
}

/**
 * Pure derivation of the wire-contract health payload from a seeder's meta
 * entry. `now` is injectable so tests and callers are deterministic.
 */
export function deriveSeederHealth(
  pluginId: string,
  meta: SeederMeta,
  now: number = Date.now(),
): SeederHealth {
  const lastRun = meta.lastRun ?? null;
  const expectedMaxAgeMs = meta.expectedMaxAgeMs ?? null;
  const stale =
    lastRun !== null &&
    expectedMaxAgeMs !== null &&
    now - lastRun > expectedMaxAgeMs;
  return {
    pluginId,
    lastRun,
    lastError: meta.lastError ?? null,
    failureCount: meta.failureCount ?? 0,
    intervalMs: meta.intervalMs ?? null,
    cron: meta.cron ?? null,
    expectedMaxAgeMs,
    stale,
  };
}
