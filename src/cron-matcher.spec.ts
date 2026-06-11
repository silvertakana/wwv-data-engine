import { describe, it, expect } from 'vitest';
import { parseCron, cronMatches } from './cron-matcher';

/** Local-time Date helper: (hour, minute) on a fixed reference day. */
function at(hour: number, minute: number, day = 11, month = 5 /* June */): Date {
  return new Date(2026, month, day, hour, minute, 5);
}

describe('parseCron', () => {
  it('parses every expression used by the production seeder fleet', () => {
    const fleet = [
      '*/1 * * * *',   // iranwarlive
      '*/2 * * * *',   // aviation
      '*/5 * * * *',   // nz-traffic-cameras
      '*/15 * * * *',  // wildfire
      '*/30 * * * *',  // civil-unrest
      '0 * * * *',     // earthquakes, international-sanctions
      '0 */2 * * *',   // cyber-attacks
      '0 0 * * *',     // conflict-events, gps-jamming
    ];
    for (const expr of fleet) {
      expect(() => parseCron(expr), expr).not.toThrow();
    }
  });

  it('accepts 6-field (seconds-first) expressions by coarsening to minutes', () => {
    const parsed = parseCron('30 */5 * * * *');
    expect(cronMatches(parsed, at(10, 5))).toBe(true);
    expect(cronMatches(parsed, at(10, 6))).toBe(false);
  });

  it('normalizes Sunday 7 to 0', () => {
    const parsed = parseCron('0 0 * * 7');
    const sunday = new Date(2026, 5, 14, 0, 0); // 2026-06-14 is a Sunday
    expect(cronMatches(parsed, sunday)).toBe(true);
  });

  it('rejects malformed expressions with descriptive errors', () => {
    expect(() => parseCron('not a cron')).toThrow(/expected 5 fields/);
    expect(() => parseCron('* * * *')).toThrow(/expected 5 fields/);
    expect(() => parseCron('60 * * * *')).toThrow(/minute/);
    expect(() => parseCron('* 24 * * *')).toThrow(/hour/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
    expect(() => parseCron('5-2 * * * *')).toThrow(/range/);
  });
});

describe('cronMatches', () => {
  it('matches hourly jobs only at minute zero', () => {
    const hourly = parseCron('0 * * * *');
    expect(cronMatches(hourly, at(10, 0))).toBe(true);
    expect(cronMatches(hourly, at(11, 0))).toBe(true);
    expect(cronMatches(hourly, at(11, 1))).toBe(false);
    expect(cronMatches(hourly, at(11, 59))).toBe(false);
  });

  it('matches step minutes', () => {
    const every15 = parseCron('*/15 * * * *');
    for (const m of [0, 15, 30, 45]) expect(cronMatches(every15, at(9, m))).toBe(true);
    for (const m of [1, 14, 29, 44, 59]) expect(cronMatches(every15, at(9, m))).toBe(false);
  });

  it('matches every-N-hours at minute zero only', () => {
    const every2h = parseCron('0 */2 * * *');
    expect(cronMatches(every2h, at(10, 0))).toBe(true);
    expect(cronMatches(every2h, at(11, 0))).toBe(false);
    expect(cronMatches(every2h, at(12, 0))).toBe(true);
    expect(cronMatches(every2h, at(12, 30))).toBe(false);
  });

  it('matches daily jobs only at midnight', () => {
    const daily = parseCron('0 0 * * *');
    expect(cronMatches(daily, at(0, 0))).toBe(true);
    expect(cronMatches(daily, at(0, 1))).toBe(false);
    expect(cronMatches(daily, at(12, 0))).toBe(false);
  });

  it('supports ranges and lists', () => {
    const business = parseCron('0 9-17 * * 1-5');
    const tueNoon = new Date(2026, 5, 9, 12, 0); // 2026-06-09 is a Tuesday
    const tueNight = new Date(2026, 5, 9, 22, 0);
    const satNoon = new Date(2026, 5, 13, 12, 0); // Saturday
    expect(cronMatches(business, tueNoon)).toBe(true);
    expect(cronMatches(business, tueNight)).toBe(false);
    expect(cronMatches(business, satNoon)).toBe(false);

    const lists = parseCron('5,35 6,18 * * *');
    expect(cronMatches(lists, at(6, 5))).toBe(true);
    expect(cronMatches(lists, at(18, 35))).toBe(true);
    expect(cronMatches(lists, at(12, 5))).toBe(false);
  });

  it('applies vixie OR semantics when both dom and dow are restricted', () => {
    // "midnight on the 13th OR on any Friday"
    const parsed = parseCron('0 0 13 * 5');
    const sat13 = new Date(2026, 5, 13, 0, 0);  // 13th (a Saturday) — dom matches
    const fri12 = new Date(2026, 5, 12, 0, 0);  // Friday the 12th — dow matches
    const thu11 = new Date(2026, 5, 11, 0, 0);  // neither
    expect(cronMatches(parsed, sat13)).toBe(true);
    expect(cronMatches(parsed, fri12)).toBe(true);
    expect(cronMatches(parsed, thu11)).toBe(false);
  });

  it('respects month restrictions', () => {
    const juneOnly = parseCron('0 0 1 6 *');
    expect(cronMatches(juneOnly, new Date(2026, 5, 1, 0, 0))).toBe(true);
    expect(cronMatches(juneOnly, new Date(2026, 6, 1, 0, 0))).toBe(false);
  });
});
